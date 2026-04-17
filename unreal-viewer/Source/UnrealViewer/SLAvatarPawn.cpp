#include "SLAvatarPawn.h"
#include "SLWebSocketServer.h"
#include "UnrealViewerModule.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/SpringArmComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "InputMappingContext.h"
#include "InputAction.h"
#include "Dom/JsonObject.h"
#include "Engine/GameInstance.h"

// ─── Constructor ───────────────────────────────────────────

ASLAvatarPawn::ASLAvatarPawn()
{
	PrimaryActorTick.bCanEverTick = true;

	// Root scene component
	USceneComponent* Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	SetRootComponent(Root);

	// Blue box mesh: 100cm cube scaled to 30x30x140cm, offset +70cm Z
	MeshComp = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("AvatarMesh"));
	MeshComp->SetupAttachment(Root);
	MeshComp->SetRelativeScale3D(FVector(0.3f, 0.3f, 1.4f));
	MeshComp->SetRelativeLocation(FVector(0, 0, 70.0f));
	MeshComp->SetCollisionEnabled(ECollisionEnabled::NoCollision);

	static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeFinder(TEXT("/Engine/BasicShapes/Cube.Cube"));
	if (CubeFinder.Succeeded())
	{
		MeshComp->SetStaticMesh(CubeFinder.Object);
	}

	// Spring arm for third-person camera
	SpringArm = CreateDefaultSubobject<USpringArmComponent>(TEXT("SpringArm"));
	SpringArm->SetupAttachment(Root);
	SpringArm->TargetArmLength = 600.0f;
	SpringArm->TargetOffset = FVector(0, 0, 80.0f);
	SpringArm->bDoCollisionTest = true;
	SpringArm->ProbeSize = 12.0f;
	SpringArm->bUsePawnControlRotation = false;
	SpringArm->bInheritPitch = false;
	SpringArm->bInheritYaw = false;
	SpringArm->bInheritRoll = false;

	// Camera at end of spring arm
	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(SpringArm, USpringArmComponent::SocketName);

	// Create Enhanced Input actions
	CreateInputActions();
}

// ─── Enhanced Input setup ──────────────────────────────────

static UInputAction* MakeBoolAction(UObject* Outer, const TCHAR* Name)
{
	UInputAction* Action = NewObject<UInputAction>(Outer, Name);
	Action->ValueType = EInputActionValueType::Boolean;
	return Action;
}

void ASLAvatarPawn::CreateInputActions()
{
	IA_MoveForward  = MakeBoolAction(this, TEXT("IA_MoveForward"));
	IA_MoveBackward = MakeBoolAction(this, TEXT("IA_MoveBackward"));
	IA_TurnLeft     = MakeBoolAction(this, TEXT("IA_TurnLeft"));
	IA_TurnRight    = MakeBoolAction(this, TEXT("IA_TurnRight"));
	IA_Jump         = MakeBoolAction(this, TEXT("IA_Jump"));
	IA_Crouch       = MakeBoolAction(this, TEXT("IA_Crouch"));
	IA_Fly          = MakeBoolAction(this, TEXT("IA_Fly"));
	IA_Run          = MakeBoolAction(this, TEXT("IA_Run"));
	IA_Escape       = MakeBoolAction(this, TEXT("IA_Escape"));

	IA_Zoom = NewObject<UInputAction>(this, TEXT("IA_Zoom"));
	IA_Zoom->ValueType = EInputActionValueType::Axis1D;

	// Build mapping context
	InputMapping = NewObject<UInputMappingContext>(this, TEXT("AvatarInputMapping"));

	InputMapping->MapKey(IA_MoveForward,  EKeys::W);
	InputMapping->MapKey(IA_MoveBackward, EKeys::S);
	InputMapping->MapKey(IA_TurnLeft,     EKeys::A);
	InputMapping->MapKey(IA_TurnRight,    EKeys::D);
	InputMapping->MapKey(IA_Jump,         EKeys::E);
	InputMapping->MapKey(IA_Crouch,       EKeys::C);
	InputMapping->MapKey(IA_Fly,          EKeys::F);
	InputMapping->MapKey(IA_Run,          EKeys::LeftShift);
	InputMapping->MapKey(IA_Zoom,         EKeys::MouseWheelAxis);
	InputMapping->MapKey(IA_Escape,       EKeys::Escape);
}

void ASLAvatarPawn::BeginPlay()
{
	Super::BeginPlay();

	// Apply blue material
	if (UStaticMesh* Mesh = MeshComp->GetStaticMesh())
	{
		UMaterialInterface* BaseMat = Mesh->GetMaterial(0);
		if (BaseMat)
		{
			UMaterialInstanceDynamic* BlueMat = UMaterialInstanceDynamic::Create(BaseMat, this);
			BlueMat->SetVectorParameterValue(TEXT("BaseColor"), FLinearColor(0.3f, 0.5f, 0.9f, 1.0f));
			MeshComp->SetMaterial(0, BlueMat);
		}
	}

	// Register input mapping context
	if (APlayerController* PC = Cast<APlayerController>(GetController()))
	{
		if (UEnhancedInputLocalPlayerSubsystem* InputSubsystem =
				ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()))
		{
			InputSubsystem->AddMappingContext(InputMapping, 0);
		}
	}

	// Get WebSocket for sending input
	if (UGameInstance* GI = GetGameInstance())
	{
		WebSocket = GI->GetSubsystem<USLWebSocketServer>();
	}

	UE_LOG(LogSLViewer, Log, TEXT("[AvatarPawn] BeginPlay — WebSocket=%s"),
		WebSocket ? TEXT("OK") : TEXT("MISSING"));
}

// ─── Input binding ─────────────────────────────────────────

void ASLAvatarPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);

	UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(PlayerInputComponent);
	if (!EIC)
	{
		UE_LOG(LogSLViewer, Error, TEXT("[AvatarPawn] Expected EnhancedInputComponent"));
		return;
	}

	EIC->BindAction(IA_MoveForward,  ETriggerEvent::Triggered, this, &ASLAvatarPawn::OnMoveForward);
	EIC->BindAction(IA_MoveForward,  ETriggerEvent::Completed, this, &ASLAvatarPawn::OnMoveForward);
	EIC->BindAction(IA_MoveBackward, ETriggerEvent::Triggered, this, &ASLAvatarPawn::OnMoveBackward);
	EIC->BindAction(IA_MoveBackward, ETriggerEvent::Completed, this, &ASLAvatarPawn::OnMoveBackward);
	EIC->BindAction(IA_TurnLeft,     ETriggerEvent::Triggered, this, &ASLAvatarPawn::OnTurnLeft);
	EIC->BindAction(IA_TurnLeft,     ETriggerEvent::Completed, this, &ASLAvatarPawn::OnTurnLeft);
	EIC->BindAction(IA_TurnRight,    ETriggerEvent::Triggered, this, &ASLAvatarPawn::OnTurnRight);
	EIC->BindAction(IA_TurnRight,    ETriggerEvent::Completed, this, &ASLAvatarPawn::OnTurnRight);
	EIC->BindAction(IA_Jump,         ETriggerEvent::Triggered, this, &ASLAvatarPawn::OnJump);
	EIC->BindAction(IA_Jump,         ETriggerEvent::Completed, this, &ASLAvatarPawn::OnJump);
	EIC->BindAction(IA_Crouch,       ETriggerEvent::Triggered, this, &ASLAvatarPawn::OnCrouch);
	EIC->BindAction(IA_Crouch,       ETriggerEvent::Completed, this, &ASLAvatarPawn::OnCrouch);
	EIC->BindAction(IA_Fly,          ETriggerEvent::Triggered, this, &ASLAvatarPawn::OnFly);
	EIC->BindAction(IA_Run,          ETriggerEvent::Triggered, this, &ASLAvatarPawn::OnRun);
	EIC->BindAction(IA_Run,          ETriggerEvent::Completed, this, &ASLAvatarPawn::OnRun);
	EIC->BindAction(IA_Zoom,         ETriggerEvent::Triggered, this, &ASLAvatarPawn::OnZoom);
	EIC->BindAction(IA_Escape,       ETriggerEvent::Started,   this, &ASLAvatarPawn::OnEscape);
}

// ─── Input callbacks ───────────────────────────────────────

void ASLAvatarPawn::OnMoveForward(const FInputActionValue& Value)
{
	const bool bNew = Value.Get<bool>();
	if (bNew != bForward)
	{
		UE_LOG(LogSLViewer, Log, TEXT("[Input] Forward %s"), bNew ? TEXT("DOWN") : TEXT("UP"));
	}
	bForward = bNew;
	bInputDirty = true;
}

void ASLAvatarPawn::OnMoveBackward(const FInputActionValue& Value)
{
	const bool bNew = Value.Get<bool>();
	if (bNew != bBackward)
	{
		UE_LOG(LogSLViewer, Log, TEXT("[Input] Backward %s"), bNew ? TEXT("DOWN") : TEXT("UP"));
	}
	bBackward = bNew;
	bInputDirty = true;
}

void ASLAvatarPawn::OnTurnLeft(const FInputActionValue& Value)
{
	const bool bNew = Value.Get<bool>();
	if (bNew != bTurnLeft)
	{
		UE_LOG(LogSLViewer, Log, TEXT("[Input] TurnLeft %s"), bNew ? TEXT("DOWN") : TEXT("UP"));
	}
	bTurnLeft = bNew;
	bInputDirty = true;
}

void ASLAvatarPawn::OnTurnRight(const FInputActionValue& Value)
{
	const bool bNew = Value.Get<bool>();
	if (bNew != bTurnRight)
	{
		UE_LOG(LogSLViewer, Log, TEXT("[Input] TurnRight %s"), bNew ? TEXT("DOWN") : TEXT("UP"));
	}
	bTurnRight = bNew;
	bInputDirty = true;
}

void ASLAvatarPawn::OnJump(const FInputActionValue& Value)
{
	const bool bNew = Value.Get<bool>();
	if (bNew != bJump)
	{
		UE_LOG(LogSLViewer, Log, TEXT("[Input] Jump %s"), bNew ? TEXT("DOWN") : TEXT("UP"));
	}
	bJump = bNew;
	bInputDirty = true;
}

void ASLAvatarPawn::OnCrouch(const FInputActionValue& Value)
{
	const bool bNew = Value.Get<bool>();
	if (bNew != bCrouch)
	{
		UE_LOG(LogSLViewer, Log, TEXT("[Input] Crouch %s"), bNew ? TEXT("DOWN") : TEXT("UP"));
	}
	bCrouch = bNew;
	bInputDirty = true;
}

void ASLAvatarPawn::OnFly(const FInputActionValue& Value)
{
	if (Value.Get<bool>())
	{
		bFlying = !bFlying;
		bFlyToggled = true;
		bInputDirty = true;
		UE_LOG(LogSLViewer, Log, TEXT("[Input] Fly toggled %s"), bFlying ? TEXT("ON") : TEXT("OFF"));
	}
}

void ASLAvatarPawn::OnRun(const FInputActionValue& Value)
{
	const bool bNew = Value.Get<bool>();
	if (bNew != bRunning)
	{
		UE_LOG(LogSLViewer, Log, TEXT("[Input] Run %s"), bNew ? TEXT("DOWN") : TEXT("UP"));
	}
	bRunning = bNew;
	bInputDirty = true;
}

void ASLAvatarPawn::OnZoom(const FInputActionValue& Value)
{
	const float ScrollDelta = Value.Get<float>();

	if (bAltOrbiting || bAltHold)
	{
		// Orbit zoom: exponential scaling
		const float Factor = (ScrollDelta > 0) ? 0.9f : 1.1f;
		OrbitDistance = FMath::Clamp(OrbitDistance * Factor, MinOrbitDistance, MaxOrbitDistance);
	}
	else
	{
		// Normal third-person zoom
		if (ScrollDelta > 0)
		{
			CameraDistance *= 0.9f;
		}
		else if (ScrollDelta < 0)
		{
			CameraDistance *= 1.1f;
		}
		CameraDistance = FMath::Clamp(CameraDistance, MinZoom, MaxZoom);
	}
}

void ASLAvatarPawn::OnEscape(const FInputActionValue& Value)
{
	if (bAltOrbiting || bAltHold)
	{
		ExitAltOrbit();
	}
}

// ─── Tick ──────────────────────────────────────────────────

void ASLAvatarPawn::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);

	// ── Alt-orbit drag update ──
	if (bAltOrbiting)
	{
		TickOrbitDrag();
	}

	// Exit orbit hold on any movement key
	if (bAltHold && (bForward || bBackward || bTurnLeft || bTurnRight))
	{
		ExitAltOrbit();
	}

	if (bAltOrbiting || bAltHold)
	{
		// ── Orbit camera positioning ──
		TickOrbitCamera();
	}
	else
	{
		// ── Normal third-person camera ──

		// A/D turning (when not holding shift for strafe)
		if (!bRunning)
		{
			if (bTurnLeft)
			{
				AvatarYaw += TurnRate * DeltaTime;
				CameraYaw += TurnRate * DeltaTime;
				bInputDirty = true;
			}
			if (bTurnRight)
			{
				AvatarYaw -= TurnRate * DeltaTime;
				CameraYaw -= TurnRate * DeltaTime;
				bInputDirty = true;
			}
		}

		// Camera always stays behind avatar
		float YawDiff = FMath::FindDeltaAngleRadians(CameraYaw, AvatarYaw);
		CameraYaw += YawDiff * FMath::Clamp(CameraReturnSpeed * DeltaTime, 0.0f, 1.0f);

		// Return pitch to default
		float PitchDiff = DefaultCameraPitch - CameraPitch;
		CameraPitch += PitchDiff * FMath::Clamp(CameraReturnSpeed * DeltaTime, 0.0f, 1.0f);

		// Update spring arm
		SpringArm->TargetArmLength = CameraDistance;
		// Negate yaw: CameraYaw is in Godot convention (positive=left) but
		// SLCoord::Rotation flips handedness, so the avatar mesh rotates in the
		// opposite direction.  Negate here so the camera matches the mesh.
		SpringArm->SetWorldRotation(FRotator(
			FMath::RadiansToDegrees(CameraPitch),
			-FMath::RadiansToDegrees(CameraYaw),
			0.0f));
	}

	// ── Send input_move (throttled to 20 Hz) ──
	InputSendTimer += DeltaTime;
	const bool bAnyMovement = bForward || bBackward || bTurnLeft || bTurnRight || bJump || bCrouch;
	if (InputSendTimer >= InputSendInterval && (bInputDirty || bAnyMovement))
	{
		SendInputMove();
		InputSendTimer = 0.0f;
		bInputDirty = false;
	}
}

// ─── Alt-orbit ─────────────────────────────────────────────

void ASLAvatarPawn::StartAltOrbit(const FVector& FocusPoint)
{
	OrbitFocus = FocusPoint;
	bAltOrbiting = true;
	bAltHold = false;

	// Compute initial spherical coords from current camera position
	const FVector CamPos = Camera->GetComponentLocation();
	const FVector Delta = CamPos - OrbitFocus;
	OrbitDistance = FMath::Max(MinOrbitDistance, Delta.Size());

	const FVector Dir = Delta.GetSafeNormal();
	OrbitPitch = FMath::Asin(FMath::Clamp(Dir.Z, -1.0f, 1.0f));
	OrbitYaw = FMath::Atan2(Dir.Y, Dir.X);

	// Disconnect spring arm from pawn transform so we can position it at the focus point
	SavedTargetOffset = SpringArm->TargetOffset;
	SpringArm->SetAbsolute(true, true, false);
	SpringArm->TargetOffset = FVector::ZeroVector;

	UE_LOG(LogSLViewer, Log, TEXT("[AltOrbit] Start focus=(%.0f,%.0f,%.0f) dist=%.0f yaw=%.1f pitch=%.1f"),
		OrbitFocus.X, OrbitFocus.Y, OrbitFocus.Z, OrbitDistance,
		FMath::RadiansToDegrees(OrbitYaw), FMath::RadiansToDegrees(OrbitPitch));
}

void ASLAvatarPawn::TransitionToOrbitHold()
{
	bAltOrbiting = false;
	bAltHold = true;

	UE_LOG(LogSLViewer, Verbose, TEXT("[AltOrbit] Holding — dist=%.0f"), OrbitDistance);
}

void ASLAvatarPawn::ExitAltOrbit()
{
	const bool WasOrbiting = bAltOrbiting || bAltHold;
	bAltOrbiting = false;
	bAltHold = false;

	// Reconnect spring arm to pawn
	SpringArm->SetAbsolute(false, false, false);
	SpringArm->TargetOffset = SavedTargetOffset;

	// Reset camera to default third-person
	CameraPitch = DefaultCameraPitch;
	CameraYaw = AvatarYaw;

	// Restore cursor and input mode
	if (APlayerController* PC = Cast<APlayerController>(GetController()))
	{
		PC->bShowMouseCursor = true;
		PC->SetInputMode(FInputModeGameAndUI()
			.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock)
			.SetHideCursorDuringCapture(false));
	}

	if (WasOrbiting)
	{
		UE_LOG(LogSLViewer, Log, TEXT("[AltOrbit] Exited — back to third-person"));
	}
}

void ASLAvatarPawn::TickOrbitDrag()
{
	APlayerController* PC = Cast<APlayerController>(GetController());
	if (!PC)
	{
		return;
	}

	float DX = 0.0f, DY = 0.0f;
	PC->GetInputMouseDelta(DX, DY);

	if (FMath::Abs(DX) < KINDA_SMALL_NUMBER && FMath::Abs(DY) < KINDA_SMALL_NUMBER)
	{
		return;
	}

	// Check modifier keys for orbit sub-modes
	const bool bCtrl = PC->IsInputKeyDown(EKeys::LeftControl) || PC->IsInputKeyDown(EKeys::RightControl);
	const bool bShift = PC->IsInputKeyDown(EKeys::LeftShift) || PC->IsInputKeyDown(EKeys::RightShift);

	if (bCtrl && bShift)
	{
		// CTRL+SHIFT: pan focus point in camera-space
		const FVector CamRight = Camera->GetRightVector();
		const FVector CamUp = Camera->GetUpVector();
		OrbitFocus += (-CamRight * DX + CamUp * DY) * OrbitDistance * 0.002f;
	}
	else if (bCtrl)
	{
		// CTRL: full orbit (yaw + pitch)
		OrbitYaw -= DX * OrbitSensitivity;
		OrbitPitch = FMath::Clamp(
			OrbitPitch + DY * OrbitSensitivity,
			FMath::DegreesToRadians(-89.0f),
			FMath::DegreesToRadians(89.0f)
		);
	}
	else
	{
		// Default: yaw rotation + Y-drag zoom
		OrbitYaw -= DX * OrbitSensitivity;
		OrbitDistance = FMath::Clamp(
			OrbitDistance + DY * OrbitDistance * 0.005f,
			MinOrbitDistance, MaxOrbitDistance
		);
	}
}

void ASLAvatarPawn::TickOrbitCamera()
{
	// Spherical → Cartesian offset from focus point
	const float CosP = FMath::Cos(OrbitPitch);
	const FVector CamOffset(
		OrbitDistance * CosP * FMath::Cos(OrbitYaw),
		OrbitDistance * CosP * FMath::Sin(OrbitYaw),
		OrbitDistance * FMath::Sin(OrbitPitch)
	);

	// Spring arm base at focus, arm extends toward camera
	SpringArm->SetWorldLocation(OrbitFocus);
	SpringArm->TargetArmLength = OrbitDistance;
	SpringArm->SetWorldRotation(CamOffset.GetSafeNormal().Rotation());
}

// ─── Input sending ─────────────────────────────────────────

void ASLAvatarPawn::SendInputMove()
{
	if (!WebSocket || !WebSocket->IsClientConnected())
	{
		return;
	}

	const bool bStrafeLeft = bTurnLeft && bRunning;
	const bool bStrafeRight = bTurnRight && bRunning;

	TSharedRef<FJsonObject> Msg = MakeShared<FJsonObject>();
	Msg->SetStringField(TEXT("type"), TEXT("input_move"));
	Msg->SetBoolField(TEXT("forward"), bForward);
	Msg->SetBoolField(TEXT("backward"), bBackward);
	Msg->SetBoolField(TEXT("strafe_left"), bStrafeLeft);
	Msg->SetBoolField(TEXT("strafe_right"), bStrafeRight);
	Msg->SetBoolField(TEXT("jump"), bJump);
	Msg->SetBoolField(TEXT("crouch"), bCrouch);
	Msg->SetBoolField(TEXT("running"), bRunning);
	Msg->SetNumberField(TEXT("yaw"), AvatarYaw);

	if (bFlyToggled)
	{
		Msg->SetBoolField(TEXT("fly"), bFlying);
		bFlyToggled = false;
	}

	WebSocket->SendJson(Msg);

	UE_LOG(LogSLViewer, Verbose, TEXT("[Input] Sent input_move fwd=%d back=%d sl=%d sr=%d jump=%d crouch=%d run=%d yaw=%.2f"),
		bForward, bBackward, bStrafeLeft, bStrafeRight, bJump, bCrouch, bRunning, AvatarYaw);
}

// ─── Avatar transform (from server) ───────────────────────

void ASLAvatarPawn::SetAvatarTransform(const FVector& UnrealPos, const FQuat& UnrealRot)
{
	SetActorLocation(UnrealPos);
	// Only rotate the mesh, not the whole pawn (camera is independent)
	MeshComp->SetWorldRotation(UnrealRot.Rotator());
}
