#include "SLPlayerController.h"
#include "SLWebSocketServer.h"
#include "SLObjectManager.h"
#include "SLAvatarPawn.h"
#include "UnrealViewerModule.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "InputMappingContext.h"
#include "InputAction.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"

// ─── Constructor ──────────────────────────────────────────

ASLPlayerController::ASLPlayerController()
{
	// Create click input action (bool: pressed/released)
	IA_Click = NewObject<UInputAction>(this, TEXT("IA_Click"));
	IA_Click->ValueType = EInputActionValueType::Boolean;

	// Map left mouse button to click
	ClickMapping = NewObject<UInputMappingContext>(this, TEXT("ClickMapping"));
	ClickMapping->MapKey(IA_Click, EKeys::LeftMouseButton);
}

// ─── BeginPlay ────────────────────────────────────────────

void ASLPlayerController::BeginPlay()
{
	Super::BeginPlay();

	// Show mouse cursor, don't capture
	bShowMouseCursor = true;
	SetInputMode(FInputModeGameAndUI()
		.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock)
		.SetHideCursorDuringCapture(false));

	// Get subsystem refs
	if (UGameInstance* GI = GetGameInstance())
	{
		WebSocket = GI->GetSubsystem<USLWebSocketServer>();
		ObjectManager = GI->GetSubsystem<USLObjectManager>();
	}

	// Register click mapping context (priority 1 = lower than pawn movement at 0)
	if (UEnhancedInputLocalPlayerSubsystem* InputSub =
			ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(GetLocalPlayer()))
	{
		InputSub->AddMappingContext(ClickMapping, 1);
	}

	UE_LOG(LogSLViewer, Log, TEXT("[PlayerController] BeginPlay — WebSocket=%s ObjectManager=%s"),
		WebSocket ? TEXT("OK") : TEXT("MISSING"),
		ObjectManager ? TEXT("OK") : TEXT("MISSING"));
}

// ─── Input binding ────────────────────────────────────────

void ASLPlayerController::SetupInputComponent()
{
	Super::SetupInputComponent();

	if (UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(InputComponent))
	{
		EIC->BindAction(IA_Click, ETriggerEvent::Started,   this, &ASLPlayerController::OnClick);
		EIC->BindAction(IA_Click, ETriggerEvent::Completed, this, &ASLPlayerController::OnClickReleased);
	}
}

// ─── Click handler ────────────────────────────────────────

void ASLPlayerController::OnClick()
{
	// ── Alt+click → start orbit camera ──
	if (IsInputKeyDown(EKeys::LeftAlt) || IsInputKeyDown(EKeys::RightAlt))
	{
		ASLAvatarPawn* AvatarPawn = Cast<ASLAvatarPawn>(GetPawn());
		if (!AvatarPawn)
		{
			return;
		}

		FVector FocusPoint;

		// Try to hit an object for precise focus
		FHitResult Hit;
		if (GetHitResultUnderCursor(ECC_Visibility, /*bTraceComplex=*/true, Hit))
		{
			FocusPoint = Hit.ImpactPoint;
		}
		else
		{
			// Fallback: ground plane at pawn Z, or 50m ahead
			FVector WorldOrigin, WorldDir;
			if (DeprojectMousePositionToWorld(WorldOrigin, WorldDir))
			{
				const float PawnZ = AvatarPawn->GetActorLocation().Z;
				if (FMath::Abs(WorldDir.Z) > KINDA_SMALL_NUMBER)
				{
					const float T = (PawnZ - WorldOrigin.Z) / WorldDir.Z;
					if (T > 0.0f && T < 50000.0f)
					{
						FocusPoint = WorldOrigin + WorldDir * T;
					}
					else
					{
						FocusPoint = WorldOrigin + WorldDir * 5000.0f;
					}
				}
				else
				{
					FocusPoint = WorldOrigin + WorldDir * 5000.0f;
				}
			}
			else
			{
				return;
			}
		}

		AvatarPawn->StartAltOrbit(FocusPoint);

		// Capture mouse during orbit drag
		bShowMouseCursor = false;
		SetInputMode(FInputModeGameOnly());
		return;
	}

	// ── Normal click → object touch ──
	if (!WebSocket || !ObjectManager)
	{
		return;
	}

	// Per-triangle line trace from cursor through the scene
	FHitResult Hit;
	if (!GetHitResultUnderCursor(ECC_Visibility, /*bTraceComplex=*/true, Hit))
	{
		return;
	}

	AActor* HitActor = Hit.GetActor();
	if (!HitActor)
	{
		return;
	}

	const FString Uuid = ObjectManager->FindUuidByActor(HitActor);
	if (Uuid.IsEmpty())
	{
		return;
	}

	// Resolve triangle index → material section (= SL face index)
	int32 FaceIndex = 0;
	if (Hit.FaceIndex >= 0)
	{
		const UStaticMeshComponent* SMC = Cast<UStaticMeshComponent>(Hit.GetComponent());
		if (SMC)
		{
			FaceIndex = GetSectionFromTriangle(SMC, Hit.FaceIndex);
		}
	}

	// Build and send object_touch message
	TSharedRef<FJsonObject> Msg = MakeShared<FJsonObject>();
	Msg->SetStringField(TEXT("type"), TEXT("object_touch"));
	Msg->SetStringField(TEXT("uuid"), Uuid);
	Msg->SetNumberField(TEXT("faceIndex"), FaceIndex);

	// ST coordinates (texture-space hit point) — placeholder until UV readback is enabled
	TSharedRef<FJsonObject> ST = MakeShared<FJsonObject>();
	ST->SetNumberField(TEXT("x"), 0.0);
	ST->SetNumberField(TEXT("y"), 0.0);
	Msg->SetObjectField(TEXT("st"), ST);

	WebSocket->SendJson(Msg);

	UE_LOG(LogSLViewer, Log, TEXT("[Pick] Touched %s face=%d tri=%d pos=(%.0f,%.0f,%.0f)"),
		*Uuid.Left(8), FaceIndex, Hit.FaceIndex,
		Hit.ImpactPoint.X, Hit.ImpactPoint.Y, Hit.ImpactPoint.Z);
}

// ─── Click release ────────────────────────────────────────

void ASLPlayerController::OnClickReleased()
{
	ASLAvatarPawn* AvatarPawn = Cast<ASLAvatarPawn>(GetPawn());
	if (AvatarPawn && AvatarPawn->IsAltOrbiting())
	{
		// Transition from active orbit drag to orbit hold
		AvatarPawn->TransitionToOrbitHold();

		bShowMouseCursor = true;
		SetInputMode(FInputModeGameAndUI()
			.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock)
			.SetHideCursorDuringCapture(false));
	}
}

// ─── Triangle → section helper ────────────────────────────

int32 ASLPlayerController::GetSectionFromTriangle(const UStaticMeshComponent* MeshComp, int32 TriIndex)
{
	if (!MeshComp) return 0;

	const UStaticMesh* Mesh = MeshComp->GetStaticMesh();
	if (!Mesh || !Mesh->GetRenderData() || Mesh->GetRenderData()->LODResources.Num() == 0)
	{
		return 0;
	}

	const FStaticMeshLODResources& LOD = Mesh->GetRenderData()->LODResources[0];
	int32 TriCount = 0;
	for (int32 i = 0; i < LOD.Sections.Num(); i++)
	{
		TriCount += LOD.Sections[i].NumTriangles;
		if (TriIndex < TriCount)
		{
			return i;
		}
	}

	return 0;
}
