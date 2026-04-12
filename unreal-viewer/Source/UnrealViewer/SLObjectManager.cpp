#include "SLObjectManager.h"
#include "SLWebSocketServer.h"
#include "SLGlbLoader.h"
#include "SLBctexLoader.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "SLCoordConvert.h"
#include "UnrealViewerModule.h"
#include "Engine/StaticMeshActor.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Kismet/GameplayStatics.h"

// ─── Helper: extract raw Godot-space vectors from JSON (no Unreal conversion) ───

static FVector GodotPosFromJson(const TSharedPtr<FJsonObject>& Json, const FString& Field = TEXT("position"))
{
	const TArray<TSharedPtr<FJsonValue>>* Arr;
	if (Json->TryGetArrayField(Field, Arr) && Arr->Num() >= 3)
	{
		return FVector((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
	}
	return FVector::ZeroVector;
}

static FQuat GodotRotFromJson(const TSharedPtr<FJsonObject>& Json, const FString& Field = TEXT("rotation"))
{
	const TArray<TSharedPtr<FJsonValue>>* Arr;
	if (Json->TryGetArrayField(Field, Arr) && Arr->Num() >= 4)
	{
		return FQuat((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber(), (*Arr)[3]->AsNumber());
	}
	return FQuat::Identity;
}

static FVector GodotScaleFromJson(const TSharedPtr<FJsonObject>& Json, const FString& Field = TEXT("scale"))
{
	const TArray<TSharedPtr<FJsonValue>>* Arr;
	if (Json->TryGetArrayField(Field, Arr) && Arr->Num() >= 3)
	{
		return FVector((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
	}
	return FVector(0.5, 0.5, 0.5);
}

// ─── Lifecycle ──────────────────────────────────────────

void USLObjectManager::Initialize(FSubsystemCollectionBase& Collection)
{
	Collection.InitializeDependency<USLWebSocketServer>();
	Collection.InitializeDependency<USLGlbLoader>();
	Collection.InitializeDependency<USLBctexLoader>();

	Super::Initialize(Collection);

	UGameInstance* GI = GetGameInstance();
	WebSocket = GI->GetSubsystem<USLWebSocketServer>();
	GlbLoader = GI->GetSubsystem<USLGlbLoader>();
	BctexLoader = GI->GetSubsystem<USLBctexLoader>();

	if (!WebSocket || !GlbLoader || !BctexLoader)
	{
		UE_LOG(LogSLViewer, Error, TEXT("[ObjectManager] Missing required subsystems"));
		return;
	}

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
			else if (Type == TEXT("terrain_ready"))
			{
				HandleTerrainReady(Json);
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

// ─── Region offsets ─────────────────────────────────────

void USLObjectManager::HandleTerrainReady(const TSharedPtr<FJsonObject>& Json)
{
	FString CacheId;
	if (!Json->TryGetStringField(TEXT("cacheID"), CacheId) || CacheId.IsEmpty())
	{
		return;
	}

	double OffsetX = 0, OffsetY = 0;
	Json->TryGetNumberField(TEXT("offsetX"), OffsetX);
	Json->TryGetNumberField(TEXT("offsetY"), OffsetY);

	// Store as Godot-space offset: SL X → Godot X, SL Y(north) → Godot -Z
	const FVector GodotOffset(OffsetX, 0.0, -OffsetY);
	RegionOffsets.Add(CacheId, GodotOffset);

	UE_LOG(LogSLViewer, Log, TEXT("[ObjectManager] Region offset: cacheID=%s offset=(%.0f, %.0f) godot=(%.0f, 0, %.0f)"),
		*CacheId.Left(8), OffsetX, OffsetY, GodotOffset.X, GodotOffset.Z);
}

// ─── Transform computation (mirrors Godot object_manager.gd) ────

FTransform USLObjectManager::ComputeWorldTransform(const TSharedPtr<FJsonObject>& Json, const FString& ParentUuid)
{
	const FVector GodotPos = GodotPosFromJson(Json);
	const FQuat GodotRot = GodotRotFromJson(Json);
	const FVector GodotScale = GodotScaleFromJson(Json);

	FVector WorldGodotPos;
	FQuat WorldGodotRot;

	if (!ParentUuid.IsEmpty())
	{
		// Child prim — position is parent-relative offset
		// World pos = parent.pos + parent.rot * offset
		const FVector* ParentPos = GodotPositions.Find(ParentUuid);
		const FQuat* ParentRot = GodotRotations.Find(ParentUuid);

		if (ParentPos && ParentRot)
		{
			WorldGodotPos = *ParentPos + *ParentRot * GodotPos;
			WorldGodotRot = *ParentRot * GodotRot;
		}
		else
		{
			// Parent hasn't arrived — use offset as-is (will be corrected on resolve)
			WorldGodotPos = GodotPos;
			WorldGodotRot = GodotRot;
		}
	}
	else
	{
		// Root prim — region-local position + region offset
		FString CacheId;
		Json->TryGetStringField(TEXT("cacheID"), CacheId);
		const FVector* Offset = CacheId.IsEmpty() ? nullptr : RegionOffsets.Find(CacheId);
		const FVector RegionOffset = Offset ? *Offset : FVector::ZeroVector;

		WorldGodotPos = GodotPos + RegionOffset;
		WorldGodotRot = GodotRot;
	}

	// Convert Godot-space → Unreal-space
	const FVector UnrealPos = SLCoord::Position(WorldGodotPos.X, WorldGodotPos.Y, WorldGodotPos.Z);
	const FQuat UnrealRot = SLCoord::Rotation(WorldGodotRot.X, WorldGodotRot.Y, WorldGodotRot.Z, WorldGodotRot.W);
	const FVector UnrealScale = SLCoord::Scale(GodotScale.X, GodotScale.Y, GodotScale.Z);

	return FTransform(UnrealRot, UnrealPos, UnrealScale);
}

// ─── Object render ──────────────────────────────────────

void USLObjectManager::HandleObjectRender(const TSharedPtr<FJsonObject>& Json)
{
	FString Uuid;
	if (!Json->TryGetStringField(TEXT("uuid"), Uuid) || Uuid.IsEmpty())
	{
		return;
	}

	if (Objects.Contains(Uuid))
	{
		return;
	}

	FString ParentUuid;
	Json->TryGetStringField(TEXT("parentUuid"), ParentUuid);

	// If this is a child and parent hasn't arrived yet, defer it
	if (!ParentUuid.IsEmpty() && !GodotPositions.Contains(ParentUuid))
	{
		PendingChildren.FindOrAdd(ParentUuid).Add(Uuid);
		PendingChildJson.Add(Uuid, Json);
		return;
	}

	// Get mesh path
	FString MeshPath, MeshId;
	if (!Json->TryGetStringField(TEXT("meshPath"), MeshPath) || MeshPath.IsEmpty())
	{
		SkippedNoMeshCount++;
		// Still store position so children can reference us as parent
		const FVector GodotPos = GodotPosFromJson(Json);
		const FQuat GodotRot = GodotRotFromJson(Json);
		FVector WorldPos = GodotPos;
		FQuat WorldRot = GodotRot;
		if (!ParentUuid.IsEmpty())
		{
			const FVector* PP = GodotPositions.Find(ParentUuid);
			const FQuat* PR = GodotRotations.Find(ParentUuid);
			if (PP && PR) { WorldPos = *PP + *PR * GodotPos; WorldRot = *PR * GodotRot; }
		}
		else
		{
			FString CacheId; Json->TryGetStringField(TEXT("cacheID"), CacheId);
			const FVector* Off = CacheId.IsEmpty() ? nullptr : RegionOffsets.Find(CacheId);
			if (Off) WorldPos = GodotPos + *Off;
		}
		GodotPositions.Add(Uuid, WorldPos);
		GodotRotations.Add(Uuid, WorldRot);
		ResolvePendingChildren(Uuid);
		return;
	}
	Json->TryGetStringField(TEXT("meshId"), MeshId);
	if (MeshId.IsEmpty()) MeshId = MeshPath;

	UStaticMesh* Mesh = GlbLoader->LoadMesh(MeshId, MeshPath);
	if (!Mesh)
	{
		return;
	}

	// Compute world transform
	const FTransform Transform = ComputeWorldTransform(Json, ParentUuid);

	// Store Godot-space world position/rotation so children can reference us
	{
		const FVector GodotPos = GodotPosFromJson(Json);
		const FQuat GodotRot = GodotRotFromJson(Json);
		FVector WorldPos = GodotPos;
		FQuat WorldRot = GodotRot;
		if (!ParentUuid.IsEmpty())
		{
			const FVector* PP = GodotPositions.Find(ParentUuid);
			const FQuat* PR = GodotRotations.Find(ParentUuid);
			if (PP && PR) { WorldPos = *PP + *PR * GodotPos; WorldRot = *PR * GodotRot; }
		}
		else
		{
			FString CacheId; Json->TryGetStringField(TEXT("cacheID"), CacheId);
			const FVector* Off = CacheId.IsEmpty() ? nullptr : RegionOffsets.Find(CacheId);
			if (Off) WorldPos = GodotPos + *Off;
		}
		GodotPositions.Add(Uuid, WorldPos);
		GodotRotations.Add(Uuid, WorldRot);
	}

	AActor* Actor = SpawnObjectActor(Uuid, Mesh, Transform, Json);
	if (!Actor)
	{
		return;
	}

	ResolvePendingChildren(Uuid);

	SpawnedCount++;
	if (SpawnedCount <= 20)
	{
		const FVector& Loc = Transform.GetLocation();
		const FVector GPos = GodotPositions.FindRef(Uuid);
		const FVector& Scl = Transform.GetScale3D();
		UE_LOG(LogSLViewer, Log, TEXT("[ObjectManager] Spawned #%d: %s godot=(%.1f,%.1f,%.1f) unreal=(%.0f,%.0f,%.0f) scale=(%.2f,%.2f,%.2f) parent=%s mesh=%s"),
			SpawnedCount, *Uuid.Left(8),
			GPos.X, GPos.Y, GPos.Z,
			Loc.X, Loc.Y, Loc.Z,
			Scl.X, Scl.Y, Scl.Z,
			ParentUuid.IsEmpty() ? TEXT("root") : *ParentUuid.Left(8),
			*MeshId.Left(8));
	}
}

AActor* USLObjectManager::SpawnObjectActor(const FString& Uuid, UStaticMesh* Mesh, const FTransform& Transform, const TSharedPtr<FJsonObject>& Json)
{
	UWorld* World = GetGameInstance()->GetWorld();
	if (!World)
	{
		return nullptr;
	}

	FActorSpawnParameters SpawnParams;
	SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	AActor* Actor = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity, SpawnParams);
	if (!Actor)
	{
		return nullptr;
	}

	UStaticMeshComponent* MeshComp = NewObject<UStaticMeshComponent>(Actor, TEXT("Mesh"));
	MeshComp->SetStaticMesh(Mesh);
	MeshComp->SetMobility(EComponentMobility::Movable);
	Actor->SetRootComponent(MeshComp);
	MeshComp->RegisterComponent();
	Actor->SetActorTransform(Transform);

	// Apply textures per face
	const TArray<TSharedPtr<FJsonValue>>* FacesArray;
	if (Json->TryGetArrayField(TEXT("faces"), FacesArray))
	{
		for (const TSharedPtr<FJsonValue>& FaceVal : *FacesArray)
		{
			const TSharedPtr<FJsonObject>* FaceObjPtr;
			if (!FaceVal->TryGetObject(FaceObjPtr))
			{
				continue;
			}
			const TSharedPtr<FJsonObject>& Face = *FaceObjPtr;

			double FaceIndex = 0;
			Face->TryGetNumberField(TEXT("index"), FaceIndex);
			const int32 MatIndex = static_cast<int32>(FaceIndex);

			// Load texture
			FString TextureId, TexturePath;
			Face->TryGetStringField(TEXT("textureId"), TextureId);
			Face->TryGetStringField(TEXT("texturePath"), TexturePath);

			UTexture2D* Texture = nullptr;
			if (!TextureId.IsEmpty() && !TexturePath.IsEmpty())
			{
				Texture = BctexLoader->LoadTexture(TextureId, TexturePath);
			}

			if (!Texture)
			{
				continue;
			}

			// Get color tint
			FLinearColor Color = FLinearColor::White;
			const TArray<TSharedPtr<FJsonValue>>* ColorArr;
			if (Face->TryGetArrayField(TEXT("color"), ColorArr) && ColorArr->Num() >= 4)
			{
				Color = FLinearColor(
					(*ColorArr)[0]->AsNumber(),
					(*ColorArr)[1]->AsNumber(),
					(*ColorArr)[2]->AsNumber(),
					(*ColorArr)[3]->AsNumber()
				);
			}

			// Pick master material based on alphaMode
			// 0 = opaque, 1 = mask (alpha cutoff), 2 = blend (translucent)
			double AlphaMode = 0;
			Face->TryGetNumberField(TEXT("alphaMode"), AlphaMode);
			// resolvedAlphaMode overrides if present (Electron computes this)
			Face->TryGetNumberField(TEXT("resolvedAlphaMode"), AlphaMode);

			static UMaterialInterface* MatOpaque = LoadObject<UMaterialInterface>(nullptr,
				TEXT("/glTFRuntime/M_glTFRuntimeBase"));
			static UMaterialInterface* MatMasked = LoadObject<UMaterialInterface>(nullptr,
				TEXT("/glTFRuntime/M_glTFRuntimeMasked_Inst"));
			static UMaterialInterface* MatTranslucent = LoadObject<UMaterialInterface>(nullptr,
				TEXT("/glTFRuntime/M_glTFRuntimeTranslucent_Inst"));

			UMaterialInterface* BaseMat = MatOpaque;
			if (static_cast<int32>(AlphaMode) == 1 && MatMasked)
			{
				BaseMat = MatMasked;
			}
			else if (static_cast<int32>(AlphaMode) == 2 && MatTranslucent)
			{
				BaseMat = MatTranslucent;
			}

			if (!BaseMat)
			{
				continue;
			}

			UMaterialInstanceDynamic* DynMat = UMaterialInstanceDynamic::Create(BaseMat, Actor);
			if (DynMat)
			{
				DynMat->SetTextureParameterValue(TEXT("baseColorTexture"), Texture);
				DynMat->SetVectorParameterValue(TEXT("baseColorFactor"), Color);

				// Set alpha cutoff for masked materials
				if (static_cast<int32>(AlphaMode) == 1)
				{
					double Cutoff = 0.5;
					Face->TryGetNumberField(TEXT("alphaCutoff"), Cutoff);
					DynMat->SetScalarParameterValue(TEXT("alphaCutoff"), static_cast<float>(Cutoff));
				}

				MeshComp->SetMaterial(MatIndex, DynMat);
			}
		}
	}

#if WITH_EDITOR
	Actor->SetActorLabel(*Uuid.Left(8));
#endif

	Objects.Add(Uuid, Actor);
	return Actor;
}

// ─── Deferred children ──────────────────────────────────

void USLObjectManager::ResolvePendingChildren(const FString& ParentUuid)
{
	TArray<FString> ChildUuids;
	if (!PendingChildren.RemoveAndCopyValue(ParentUuid, ChildUuids))
	{
		return;
	}

	int32 Resolved = 0;
	for (const FString& ChildUuid : ChildUuids)
	{
		TSharedPtr<FJsonObject> ChildJson;
		if (PendingChildJson.RemoveAndCopyValue(ChildUuid, ChildJson))
		{
			// Re-process the child now that parent position is known
			HandleObjectRender(ChildJson);
			Resolved++;
		}
	}

	if (Resolved > 0)
	{
		UE_LOG(LogSLViewer, Verbose, TEXT("[ObjectManager] Resolved %d pending children for parent %s"),
			Resolved, *ParentUuid.Left(8));
	}
}

// ─── Updates ────────────────────────────────────────────

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

		// Updates come as Godot-space positions — for root prims, add stored region offset
		const FVector GodotPos = GodotPosFromJson(Obj);
		const FQuat GodotRot = GodotRotFromJson(Obj);

		const FVector* StoredOffset = ObjectRegionOffset.Find(Uuid);
		const FVector WorldGodotPos = StoredOffset ? GodotPos + *StoredOffset : GodotPos;

		const FVector UnrealPos = SLCoord::Position(WorldGodotPos.X, WorldGodotPos.Y, WorldGodotPos.Z);
		const FQuat UnrealRot = SLCoord::Rotation(GodotRot.X, GodotRot.Y, GodotRot.Z, GodotRot.W);

		// Update stored Godot position for child computation
		GodotPositions.Add(Uuid, WorldGodotPos);
		GodotRotations.Add(Uuid, GodotRot);

		(*ActorPtr)->SetActorLocationAndRotation(UnrealPos, UnrealRot);
	}
}

// ─── Avatar camera ──────────────────────────────────────

void USLObjectManager::HandleAvatarUpdate(const TSharedPtr<FJsonObject>& Json)
{
	if (bCameraPositioned || SelfAvatarId.IsEmpty())
	{
		return;
	}

	FString AvatarId;
	FVector GodotPos = FVector::ZeroVector;

	if (Json->HasField(TEXT("avatars")))
	{
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
						GodotPos = GodotPosFromJson(*AvatarObj);
						AvatarId = Id;
						break;
					}
				}
			}
		}
	}
	else
	{
		Json->TryGetStringField(TEXT("id"), AvatarId);
		if (AvatarId == SelfAvatarId)
		{
			GodotPos = GodotPosFromJson(Json);
		}
	}

	if (AvatarId != SelfAvatarId || GodotPos.IsNearlyZero())
	{
		return;
	}

	// Avatar position is region-local in Godot space — same coordinate system as root prims
	const FVector UnrealPos = SLCoord::Position(GodotPos.X, GodotPos.Y, GodotPos.Z);

	UWorld* World = GetGameInstance()->GetWorld();
	if (!World) return;

	APawn* Pawn = UGameplayStatics::GetPlayerPawn(World, 0);
	if (Pawn)
	{
		// 3m above avatar
		const FVector CameraPos = UnrealPos + FVector(0, 0, 300.0f);
		Pawn->SetActorLocation(CameraPos);
		bCameraPositioned = true;
		UE_LOG(LogSLViewer, Log, TEXT("[ObjectManager] Camera at avatar: godot=(%.1f, %.1f, %.1f) unreal=(%.0f, %.0f, %.0f)"),
			GodotPos.X, GodotPos.Y, GodotPos.Z, CameraPos.X, CameraPos.Y, CameraPos.Z);
	}
}

// ─── Kill / clear ───────────────────────────────────────

void USLObjectManager::HandleObjectKill(const TSharedPtr<FJsonObject>& Json)
{
	const TArray<TSharedPtr<FJsonValue>>* UuidsArray;
	if (!Json->TryGetArrayField(TEXT("uuids"), UuidsArray))
	{
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
	if (Objects.RemoveAndCopyValue(Uuid, Actor))
	{
		if (Actor) Actor->Destroy();
	}
	GodotPositions.Remove(Uuid);
	GodotRotations.Remove(Uuid);
	ObjectRegionOffset.Remove(Uuid);
	PendingChildren.Remove(Uuid);
	PendingChildJson.Remove(Uuid);
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
		if (Actor) Actor->Destroy();
	}
	Objects.Empty();
	PendingChildren.Empty();
	PendingChildJson.Empty();
	GodotPositions.Empty();
	GodotRotations.Empty();
	ObjectRegionOffset.Empty();
	RegionOffsets.Empty();
}
