#include "SLAvatarManager.h"
#include "SLAvatarPawn.h"
#include "SLWebSocketServer.h"
#include "SLCoordConvert.h"
#include "UnrealViewerModule.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Engine/GameInstance.h"
#include "Kismet/GameplayStatics.h"

// ─── Helper: extract raw Godot-space vectors from JSON ─────

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

static FVector GodotVelFromJson(const TSharedPtr<FJsonObject>& Json)
{
	return GodotPosFromJson(Json, TEXT("velocity"));
}

// ─── Lifecycle ─────────────────────────────────────────────

void USLAvatarManager::Initialize(FSubsystemCollectionBase& Collection)
{
	Collection.InitializeDependency<USLWebSocketServer>();
	Super::Initialize(Collection);

	UGameInstance* GI = GetGameInstance();
	WebSocket = GI->GetSubsystem<USLWebSocketServer>();
	if (!WebSocket)
	{
		UE_LOG(LogSLViewer, Error, TEXT("[AvatarManager] Missing WebSocket subsystem"));
		return;
	}

	CreateSharedResources();

	MessageHandle = WebSocket->OnJsonMessage.AddLambda(
		[this](const FString& Type, const TSharedPtr<FJsonObject>& Json)
		{
			if (Type == TEXT("self_id"))
			{
				HandleSelfId(Json);
			}
			else if (Type == TEXT("avatar_create"))
			{
				HandleAvatarCreate(Json);
			}
			else if (Type == TEXT("avatar_update") || Type == TEXT("avatar_update_batch"))
			{
				HandleAvatarUpdateBatch(Json);
			}
			else if (Type == TEXT("avatar_kill"))
			{
				HandleAvatarKill(Json);
			}
			else if (Type == TEXT("region_change"))
			{
				HandleRegionChange();
			}
		});

	TickHandle = FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateUObject(this, &USLAvatarManager::Tick));

	UE_LOG(LogSLViewer, Log, TEXT("[AvatarManager] Initialized"));
}

void USLAvatarManager::Deinitialize()
{
	FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);

	if (WebSocket)
	{
		WebSocket->OnJsonMessage.Remove(MessageHandle);
	}

	Super::Deinitialize();
}

// ─── Shared resources ──────────────────────────────────────

void USLAvatarManager::CreateSharedResources()
{
	CubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
	if (!CubeMesh)
	{
		UE_LOG(LogSLViewer, Error, TEXT("[AvatarManager] Failed to load Cube mesh"));
		return;
	}

	// Create blue material — find a base material to instance from
	UMaterialInterface* BaseMat = CubeMesh->GetMaterial(0);
	if (BaseMat)
	{
		BlueMaterial = UMaterialInstanceDynamic::Create(BaseMat, this);
		BlueMaterial->SetVectorParameterValue(TEXT("BaseColor"), FLinearColor(0.3f, 0.5f, 0.9f, 1.0f));
	}

	UE_LOG(LogSLViewer, Log, TEXT("[AvatarManager] Shared resources: cube=%s mat=%s"),
		CubeMesh ? TEXT("OK") : TEXT("MISSING"),
		BlueMaterial ? TEXT("OK") : TEXT("MISSING"));
}

// ─── Message handlers ──────────────────────────────────────

void USLAvatarManager::HandleSelfId(const TSharedPtr<FJsonObject>& Json)
{
	Json->TryGetStringField(TEXT("id"), SelfAvatarId);
	UE_LOG(LogSLViewer, Log, TEXT("[AvatarManager] Self ID: %s"), *SelfAvatarId);
}

void USLAvatarManager::HandleAvatarCreate(const TSharedPtr<FJsonObject>& Json)
{
	FString Id;
	if (!Json->TryGetStringField(TEXT("id"), Id))
	{
		return;
	}

	// Skip if already tracked
	if (Avatars.Contains(Id))
	{
		return;
	}

	const FVector GodotPos = GodotPosFromJson(Json);
	const FQuat GodotRot = GodotRotFromJson(Json);

	if (Id == SelfAvatarId)
	{
		RegisterSelfPawn();
		if (SelfPawn)
		{
			Avatars.Add(Id, SelfPawn);
			FAvatarInterpState& State = InterpStates.FindOrAdd(Id);
			State.CurrentPos = GodotPos;
			State.CurrentRot = GodotRot;
			State.TargetPos = GodotPos;
			State.TargetRot = GodotRot;
			State.Velocity = FVector::ZeroVector;
			State.Age = 0.0f;

			// Immediately position the pawn
			const FVector UnrealPos = SLCoord::Position(GodotPos.X, GodotPos.Y, GodotPos.Z);
			const FQuat UnrealRot = SLCoord::Rotation(GodotRot.X, GodotRot.Y, GodotRot.Z, GodotRot.W);
			SelfPawn->SetAvatarTransform(UnrealPos, UnrealRot);

			UE_LOG(LogSLViewer, Log, TEXT("[AvatarManager] Self avatar created at godot=(%.1f, %.1f, %.1f)"),
				GodotPos.X, GodotPos.Y, GodotPos.Z);
		}
	}
	else
	{
		AActor* Actor = SpawnOtherAvatar(Id, GodotPos, GodotRot);
		if (Actor)
		{
			Avatars.Add(Id, Actor);
			FAvatarInterpState& State = InterpStates.FindOrAdd(Id);
			State.CurrentPos = GodotPos;
			State.CurrentRot = GodotRot;
			State.TargetPos = GodotPos;
			State.TargetRot = GodotRot;
			State.Velocity = FVector::ZeroVector;
			State.Age = 0.0f;
		}
	}
}

void USLAvatarManager::HandleAvatarUpdateBatch(const TSharedPtr<FJsonObject>& Json)
{
	// Handle both single avatar_update and batched avatar_update_batch
	const TArray<TSharedPtr<FJsonValue>>* AvatarsArray;
	if (Json->TryGetArrayField(TEXT("avatars"), AvatarsArray))
	{
		for (const auto& Entry : *AvatarsArray)
		{
			const TSharedPtr<FJsonObject>* AvatarObj;
			if (!Entry->TryGetObject(AvatarObj))
			{
				continue;
			}

			FString Id;
			if (!(*AvatarObj)->TryGetStringField(TEXT("id"), Id))
			{
				continue;
			}

			// Auto-create if we haven't seen this avatar yet
			if (!Avatars.Contains(Id))
			{
				HandleAvatarCreate(*AvatarObj);
			}

			FAvatarInterpState* State = InterpStates.Find(Id);
			if (!State)
			{
				continue;
			}

			// Only update fields that are present in the JSON (matching Godot)
			const FVector OldPos = State->TargetPos;
			if ((*AvatarObj)->HasField(TEXT("position")))
			{
				State->TargetPos = GodotPosFromJson(*AvatarObj);
			}
			if ((*AvatarObj)->HasField(TEXT("rotation")))
			{
				State->TargetRot = GodotRotFromJson(*AvatarObj);
			}
			// Preserve old velocity when update doesn't include one
			// (matching Firestorm — velocity persists until explicitly changed)
			if ((*AvatarObj)->HasField(TEXT("velocity")))
			{
				State->Velocity = GodotVelFromJson(*AvatarObj);
			}

			State->Age = 0.0f;

			// Log self avatar updates at Log level, others at Verbose
			if (Id == SelfAvatarId)
			{
				const FVector Delta = State->TargetPos - OldPos;
				UE_LOG(LogSLViewer, Log, TEXT("[AvatarUpdate] SELF pos=(%.2f, %.2f, %.2f) delta=(%.3f, %.3f, %.3f) vel=(%.2f, %.2f, %.2f) age=%.3fs"),
					State->TargetPos.X, State->TargetPos.Y, State->TargetPos.Z,
					Delta.X, Delta.Y, Delta.Z,
					State->Velocity.X, State->Velocity.Y, State->Velocity.Z,
					State->Age);
			}
			else
			{
				UE_LOG(LogSLViewer, Verbose, TEXT("[AvatarUpdate] %s pos=(%.2f, %.2f, %.2f) vel=(%.2f, %.2f, %.2f)"),
					*Id.Left(8),
					State->TargetPos.X, State->TargetPos.Y, State->TargetPos.Z,
					State->Velocity.X, State->Velocity.Y, State->Velocity.Z);
			}
		}
	}
	else
	{
		// Single avatar_update message
		FString Id;
		if (!Json->TryGetStringField(TEXT("id"), Id))
		{
			return;
		}

		if (!Avatars.Contains(Id))
		{
			HandleAvatarCreate(Json);
		}

		FAvatarInterpState* State = InterpStates.Find(Id);
		if (!State)
		{
			return;
		}

		const FVector OldPos = State->TargetPos;
		if (Json->HasField(TEXT("position")))
		{
			State->TargetPos = GodotPosFromJson(Json);
		}
		if (Json->HasField(TEXT("rotation")))
		{
			State->TargetRot = GodotRotFromJson(Json);
		}
		if (Json->HasField(TEXT("velocity")))
		{
			State->Velocity = GodotVelFromJson(Json);
		}

		State->Age = 0.0f;

		if (Id == SelfAvatarId)
		{
			const FVector Delta = State->TargetPos - OldPos;
			UE_LOG(LogSLViewer, Log, TEXT("[AvatarUpdate] SELF pos=(%.2f, %.2f, %.2f) delta=(%.3f, %.3f, %.3f) vel=(%.2f, %.2f, %.2f)"),
				State->TargetPos.X, State->TargetPos.Y, State->TargetPos.Z,
				Delta.X, Delta.Y, Delta.Z,
				State->Velocity.X, State->Velocity.Y, State->Velocity.Z);
		}
	}
}

void USLAvatarManager::HandleAvatarKill(const TSharedPtr<FJsonObject>& Json)
{
	FString Id;
	if (!Json->TryGetStringField(TEXT("id"), Id))
	{
		return;
	}

	InterpStates.Remove(Id);

	TObjectPtr<AActor>* ActorPtr = Avatars.Find(Id);
	if (!ActorPtr || !*ActorPtr)
	{
		Avatars.Remove(Id);
		return;
	}

	// Don't destroy the self pawn — just untrack it
	if (Id == SelfAvatarId)
	{
		Avatars.Remove(Id);
		return;
	}

	(*ActorPtr)->Destroy();
	Avatars.Remove(Id);

	UE_LOG(LogSLViewer, Verbose, TEXT("[AvatarManager] Killed avatar %s"), *Id);
}

void USLAvatarManager::HandleRegionChange()
{
	// Destroy all non-self avatars
	for (auto It = Avatars.CreateIterator(); It; ++It)
	{
		if (It->Key != SelfAvatarId && It->Value)
		{
			It->Value->Destroy();
		}
	}

	Avatars.Reset();
	InterpStates.Reset();

	// Re-register self pawn if we have one
	if (SelfPawn && !SelfAvatarId.IsEmpty())
	{
		Avatars.Add(SelfAvatarId, SelfPawn);
	}

	UE_LOG(LogSLViewer, Log, TEXT("[AvatarManager] Region change — cleared avatars"));
}

// ─── Tick / Interpolation ──────────────────────────────────

bool USLAvatarManager::Tick(float DeltaTime)
{
	for (auto& Pair : InterpStates)
	{
		TObjectPtr<AActor>* ActorPtr = Avatars.Find(Pair.Key);
		if (!ActorPtr || !*ActorPtr)
		{
			continue;
		}

		InterpolateAvatar(Pair.Key, Pair.Value, DeltaTime);
	}

	return true; // keep ticking
}

void USLAvatarManager::InterpolateAvatar(const FString& Id, FAvatarInterpState& S, float DeltaTime)
{
	S.Age += DeltaTime;

	// ── Phase 1: No interpolation — snap directly to server position ──
	// Velocity is stored in S.Velocity for Phase 2 but not applied.
	S.CurrentPos = S.TargetPos;

	const bool bIsSelf = (Id == SelfAvatarId);
	if (bIsSelf && SelfPawn)
	{
		// Client-authoritative yaw — snap, no pelvis lag
		const float AvatarYaw = SelfPawn->GetAvatarYaw();
		S.CurrentRot = FQuat(FVector(0, 1, 0), AvatarYaw);
	}
	else
	{
		S.CurrentRot = S.TargetRot;
	}

	// Convert Godot -> Unreal and apply
	const FVector UnrealPos = SLCoord::Position(S.CurrentPos.X, S.CurrentPos.Y, S.CurrentPos.Z);
	const FQuat UnrealRot = SLCoord::Rotation(S.CurrentRot.X, S.CurrentRot.Y, S.CurrentRot.Z, S.CurrentRot.W);

	TObjectPtr<AActor>* ActorPtr = Avatars.Find(Id);
	if (!ActorPtr || !*ActorPtr)
	{
		return;
	}

	if (bIsSelf && SelfPawn)
	{
		SelfPawn->SetAvatarTransform(UnrealPos, UnrealRot);
	}
	else
	{
		(*ActorPtr)->SetActorLocationAndRotation(UnrealPos, UnrealRot);
	}
}

// ─── Spawn helpers ─────────────────────────────────────────

void USLAvatarManager::RegisterSelfPawn()
{
	if (SelfPawn)
	{
		return;
	}

	UWorld* World = GetGameInstance()->GetWorld();
	if (!World)
	{
		return;
	}

	APawn* Pawn = UGameplayStatics::GetPlayerPawn(World, 0);
	SelfPawn = Cast<ASLAvatarPawn>(Pawn);

	if (SelfPawn)
	{
		UE_LOG(LogSLViewer, Log, TEXT("[AvatarManager] Registered self pawn"));
	}
	else
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[AvatarManager] Player pawn is not ASLAvatarPawn — got %s"),
			Pawn ? *Pawn->GetClass()->GetName() : TEXT("null"));
	}
}

AActor* USLAvatarManager::SpawnOtherAvatar(const FString& Id, const FVector& GodotPos, const FQuat& GodotRot)
{
	UWorld* World = GetGameInstance()->GetWorld();
	if (!World || !CubeMesh)
	{
		return nullptr;
	}

	const FVector UnrealPos = SLCoord::Position(GodotPos.X, GodotPos.Y, GodotPos.Z);
	const FQuat UnrealRot = SLCoord::Rotation(GodotRot.X, GodotRot.Y, GodotRot.Z, GodotRot.W);

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	AActor* Actor = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform(UnrealRot, UnrealPos), Params);
	if (!Actor)
	{
		return nullptr;
	}

	// Root component
	USceneComponent* Root = NewObject<USceneComponent>(Actor, TEXT("Root"));
	Actor->SetRootComponent(Root);
	Root->RegisterComponent();

	// Blue box mesh: 100cm cube scaled to 30x30x140cm, offset +70cm Z (feet at pivot)
	UStaticMeshComponent* MeshComp = NewObject<UStaticMeshComponent>(Actor, TEXT("AvatarMesh"));
	MeshComp->SetStaticMesh(CubeMesh);
	MeshComp->SetRelativeScale3D(FVector(0.3f, 0.3f, 1.4f));
	MeshComp->SetRelativeLocation(FVector(0, 0, 70.0f));
	if (BlueMaterial)
	{
		MeshComp->SetMaterial(0, BlueMaterial);
	}
	MeshComp->SetMobility(EComponentMobility::Movable);
	MeshComp->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	MeshComp->SetupAttachment(Root);
	MeshComp->RegisterComponent();

	UE_LOG(LogSLViewer, Verbose, TEXT("[AvatarManager] Spawned other avatar %s"), *Id);
	return Actor;
}
