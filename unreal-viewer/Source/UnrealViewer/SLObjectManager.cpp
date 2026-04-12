#include "SLObjectManager.h"
#include "SLWebSocketServer.h"
#include "SLGlbLoader.h"
#include "SLCoordConvert.h"
#include "UnrealViewerModule.h"
#include "Engine/StaticMeshActor.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Kismet/GameplayStatics.h"

void USLObjectManager::Initialize(FSubsystemCollectionBase& Collection)
{
	// Declare dependencies — ensures these subsystems initialize before us
	Collection.InitializeDependency<USLWebSocketServer>();
	Collection.InitializeDependency<USLGlbLoader>();

	Super::Initialize(Collection);

	// Get sibling subsystems (guaranteed to exist now)
	UGameInstance* GI = GetGameInstance();
	WebSocket = GI->GetSubsystem<USLWebSocketServer>();
	GlbLoader = GI->GetSubsystem<USLGlbLoader>();

	if (!WebSocket || !GlbLoader)
	{
		UE_LOG(LogSLViewer, Error, TEXT("[ObjectManager] Missing required subsystems"));
		return;
	}

	// Subscribe to WebSocket messages
	MessageHandle = WebSocket->OnJsonMessage.AddLambda(
		[this](const FString& Type, const TSharedPtr<FJsonObject>& Json)
		{
			if (Type == TEXT("object_render"))
			{
				HandleObjectRender(Json);
			}
			else if (Type == TEXT("object_update_batch"))
			{
				HandleObjectUpdateBatch(Json);
			}
			else if (Type == TEXT("object_kill"))
			{
				HandleObjectKill(Json);
			}
			else if (Type == TEXT("self_id"))
			{
				Json->TryGetStringField(TEXT("id"), SelfAvatarId);
			}
			else if (Type == TEXT("avatar_create") || Type == TEXT("avatar_update") || Type == TEXT("avatar_update_batch"))
			{
				HandleAvatarUpdate(Json);
			}
			else if (Type == TEXT("region_change"))
			{
				bCameraPositioned = false;
				HandleRegionChange();
			}
		}
	);

	UE_LOG(LogSLViewer, Log, TEXT("[ObjectManager] Initialized, listening for object messages"));
}

void USLObjectManager::Deinitialize()
{
	if (WebSocket)
	{
		WebSocket->OnJsonMessage.Remove(MessageHandle);
	}

	UE_LOG(LogSLViewer, Log, TEXT("[ObjectManager] Shutting down — %d objects spawned, %d skipped (no mesh), %d alive"),
		SpawnedCount, SkippedNoMeshCount, Objects.Num());

	ClearAll();
	Super::Deinitialize();
}

void USLObjectManager::HandleObjectRender(const TSharedPtr<FJsonObject>& Json)
{
	FString Uuid;
	if (!Json->TryGetStringField(TEXT("uuid"), Uuid) || Uuid.IsEmpty())
	{
		return;
	}

	// Skip if already spawned
	if (Objects.Contains(Uuid))
	{
		return;
	}

	// Get mesh path — objects without meshPath are procedural prims (skip for now)
	FString MeshPath;
	FString MeshId;
	if (!Json->TryGetStringField(TEXT("meshPath"), MeshPath) || MeshPath.IsEmpty())
	{
		SkippedNoMeshCount++;
		return;
	}
	Json->TryGetStringField(TEXT("meshId"), MeshId);
	if (MeshId.IsEmpty())
	{
		// Fall back to meshPath as cache key
		MeshId = MeshPath;
	}

	// Load mesh (cached by meshId)
	UStaticMesh* Mesh = GlbLoader->LoadMesh(MeshId, MeshPath);
	if (!Mesh)
	{
		return;
	}

	// Build transform from Godot coords
	const FVector Location = SLCoord::PositionFromJson(Json);
	const FQuat Rot = SLCoord::RotationFromJson(Json);
	const FVector Scl = SLCoord::ScaleFromJson(Json);
	const FTransform Transform(Rot, Location, Scl);

	// Spawn actor
	AActor* Actor = SpawnObjectActor(Uuid, Mesh, Transform);
	if (!Actor)
	{
		return;
	}

	// Handle parent attachment
	FString ParentUuid;
	if (Json->TryGetStringField(TEXT("parentUuid"), ParentUuid) && !ParentUuid.IsEmpty())
	{
		AttachToParent(Actor, Uuid, ParentUuid);
	}

	// Resolve any children that arrived before this parent
	ResolvePendingChildren(Uuid);

	SpawnedCount++;
	if (SpawnedCount <= 10 || (SpawnedCount % 100 == 0))
	{
		UE_LOG(LogSLViewer, Log, TEXT("[ObjectManager] Spawned #%d: %s at (%.0f, %.0f, %.0f) mesh=%s cache=%d"),
			SpawnedCount, *Uuid.Left(8), Location.X, Location.Y, Location.Z,
			*MeshId.Left(8), GlbLoader->GetCacheSize());
	}
}

AActor* USLObjectManager::SpawnObjectActor(const FString& Uuid, UStaticMesh* Mesh, const FTransform& Transform)
{
	UWorld* World = GetGameInstance()->GetWorld();
	if (!World)
	{
		return nullptr;
	}

	FActorSpawnParameters SpawnParams;
	SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	AActor* Actor = World->SpawnActor<AActor>(AActor::StaticClass(), Transform, SpawnParams);
	if (!Actor)
	{
		return nullptr;
	}

	// Create root scene component
	USceneComponent* Root = NewObject<USceneComponent>(Actor, TEXT("Root"));
	Actor->SetRootComponent(Root);
	Root->RegisterComponent();

	// Add static mesh component
	UStaticMeshComponent* MeshComp = NewObject<UStaticMeshComponent>(Actor, TEXT("Mesh"));
	MeshComp->SetStaticMesh(Mesh);
	MeshComp->SetMobility(EComponentMobility::Movable);
	MeshComp->AttachToComponent(Root, FAttachmentTransformRules::KeepRelativeTransform);
	MeshComp->RegisterComponent();

#if WITH_EDITOR
	Actor->SetActorLabel(*Uuid.Left(8));
#endif

	Objects.Add(Uuid, Actor);
	return Actor;
}

void USLObjectManager::AttachToParent(AActor* Child, const FString& ChildUuid, const FString& ParentUuid)
{
	if (TObjectPtr<AActor>* ParentPtr = Objects.Find(ParentUuid))
	{
		// Parent exists — attach now
		Child->AttachToActor(*ParentPtr, FAttachmentTransformRules::KeepWorldTransform);
	}
	else
	{
		// Parent hasn't arrived yet — defer
		PendingChildren.FindOrAdd(ParentUuid).Add(ChildUuid);
		ChildToParent.Add(ChildUuid, ParentUuid);
	}
}

void USLObjectManager::ResolvePendingChildren(const FString& ParentUuid)
{
	TArray<FString> ChildUuids;
	if (!PendingChildren.RemoveAndCopyValue(ParentUuid, ChildUuids))
	{
		return;
	}

	TObjectPtr<AActor>* ParentPtr = Objects.Find(ParentUuid);
	if (!ParentPtr)
	{
		return;
	}

	for (const FString& ChildUuid : ChildUuids)
	{
		ChildToParent.Remove(ChildUuid);
		if (TObjectPtr<AActor>* ChildPtr = Objects.Find(ChildUuid))
		{
			(*ChildPtr)->AttachToActor(*ParentPtr, FAttachmentTransformRules::KeepWorldTransform);
		}
	}

	if (ChildUuids.Num() > 0)
	{
		UE_LOG(LogSLViewer, Verbose, TEXT("[ObjectManager] Resolved %d pending children for parent %s"),
			ChildUuids.Num(), *ParentUuid.Left(8));
	}
}

void USLObjectManager::HandleObjectUpdateBatch(const TSharedPtr<FJsonObject>& Json)
{
	const TArray<TSharedPtr<FJsonValue>>* ObjectsArray;
	if (!Json->TryGetArrayField(TEXT("objects"), ObjectsArray))
	{
		return;
	}

	for (const TSharedPtr<FJsonValue>& Entry : *ObjectsArray)
	{
		const TSharedPtr<FJsonObject>* ObjPtr;
		if (!Entry->TryGetObject(ObjPtr))
		{
			continue;
		}
		const TSharedPtr<FJsonObject>& Obj = *ObjPtr;

		FString Uuid;
		if (!Obj->TryGetStringField(TEXT("uuid"), Uuid))
		{
			continue;
		}

		TObjectPtr<AActor>* ActorPtr = Objects.Find(Uuid);
		if (!ActorPtr || !*ActorPtr)
		{
			continue;
		}

		const FVector Location = SLCoord::PositionFromJson(Obj);
		const FQuat Rot = SLCoord::RotationFromJson(Obj);
		const FVector Scl = SLCoord::ScaleFromJson(Obj);

		(*ActorPtr)->SetActorTransform(FTransform(Rot, Location, Scl));
	}
}

void USLObjectManager::HandleAvatarUpdate(const TSharedPtr<FJsonObject>& Json)
{
	if (bCameraPositioned || SelfAvatarId.IsEmpty())
	{
		return;
	}

	// avatar_update has id/position directly; avatar_update_batch has an avatars array
	FString AvatarId;
	FVector AvatarPos = FVector::ZeroVector;

	if (Json->HasField(TEXT("avatars")))
	{
		// Batch — find self in the array
		const TArray<TSharedPtr<FJsonValue>>* Avatars;
		if (Json->TryGetArrayField(TEXT("avatars"), Avatars))
		{
			for (const auto& Entry : *Avatars)
			{
				const TSharedPtr<FJsonObject>* AvatarObj;
				if (Entry->TryGetObject(AvatarObj))
				{
					FString Id;
					if ((*AvatarObj)->TryGetStringField(TEXT("id"), Id) && Id == SelfAvatarId)
					{
						AvatarPos = SLCoord::PositionFromJson(*AvatarObj);
						AvatarId = Id;
						break;
					}
				}
			}
		}
	}
	else
	{
		// Single update
		Json->TryGetStringField(TEXT("id"), AvatarId);
		if (AvatarId == SelfAvatarId)
		{
			AvatarPos = SLCoord::PositionFromJson(Json);
		}
	}

	if (AvatarId != SelfAvatarId || AvatarPos.IsNearlyZero())
	{
		return;
	}

	// Move the spectator pawn to the avatar's position, slightly above and behind
	UWorld* World = GetGameInstance()->GetWorld();
	if (!World)
	{
		return;
	}

	APawn* Pawn = UGameplayStatics::GetPlayerPawn(World, 0);
	if (Pawn)
	{
		// Position camera 3m above avatar (300 cm)
		const FVector CameraPos = AvatarPos + FVector(0, 0, 300.0f);
		Pawn->SetActorLocation(CameraPos);
		bCameraPositioned = true;
		UE_LOG(LogSLViewer, Log, TEXT("[ObjectManager] Camera positioned at avatar: (%.0f, %.0f, %.0f)"),
			CameraPos.X, CameraPos.Y, CameraPos.Z);
	}
}

void USLObjectManager::HandleObjectKill(const TSharedPtr<FJsonObject>& Json)
{
	const TArray<TSharedPtr<FJsonValue>>* UuidsArray;
	if (!Json->TryGetArrayField(TEXT("uuids"), UuidsArray))
	{
		// Single kill
		FString Uuid;
		if (Json->TryGetStringField(TEXT("uuid"), Uuid))
		{
			DestroyObject(Uuid);
		}
		return;
	}

	for (const TSharedPtr<FJsonValue>& Entry : *UuidsArray)
	{
		DestroyObject(Entry->AsString());
	}
}

void USLObjectManager::DestroyObject(const FString& Uuid)
{
	TObjectPtr<AActor> Actor;
	if (!Objects.RemoveAndCopyValue(Uuid, Actor))
	{
		return;
	}

	if (Actor)
	{
		Actor->Destroy();
	}

	// Clean up any pending children references
	PendingChildren.Remove(Uuid);
	ChildToParent.Remove(Uuid);
}

void USLObjectManager::HandleRegionChange()
{
	UE_LOG(LogSLViewer, Log, TEXT("[ObjectManager] Region change — clearing %d objects"), Objects.Num());
	ClearAll();
}

void USLObjectManager::ClearAll()
{
	for (auto& [Uuid, Actor] : Objects)
	{
		if (Actor)
		{
			Actor->Destroy();
		}
	}
	Objects.Empty();
	PendingChildren.Empty();
	ChildToParent.Empty();
}
