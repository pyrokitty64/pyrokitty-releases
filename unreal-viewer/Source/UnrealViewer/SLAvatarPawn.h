#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "InputActionValue.h"
#include "SLAvatarPawn.generated.h"

class USpringArmComponent;
class UCameraComponent;
class UStaticMeshComponent;
class UInputAction;
class UInputMappingContext;
class USLWebSocketServer;

/**
 * Third-person avatar pawn — blue placeholder box with spring arm camera.
 * Does NOT move itself: sends input_move to Electron, receives position
 * updates from USLAvatarManager.
 *
 * Alt-orbit: Alt+click picks a focus point, camera orbits around it.
 * Ctrl = pitch, Ctrl+Shift = pan, Escape/movement = exit.
 */
UCLASS()
class UNREALVIEWER_API ASLAvatarPawn : public APawn
{
	GENERATED_BODY()

public:
	ASLAvatarPawn();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaTime) override;
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

	/** Called by USLAvatarManager to set position from server updates. */
	void SetAvatarTransform(const FVector& UnrealPos, const FQuat& UnrealRot);

	/** Current avatar facing yaw in Godot-space radians (for input_move). */
	float GetAvatarYaw() const { return AvatarYaw; }

	// ── Alt-orbit public interface (called by SLPlayerController) ──

	/** Enter alt-orbit mode, focusing on FocusPoint. */
	void StartAltOrbit(const FVector& FocusPoint);

	/** Transition from active orbit drag to orbit hold (camera stays, cursor returns). */
	void TransitionToOrbitHold();

	/** Exit alt-orbit entirely, return to normal third-person camera. */
	void ExitAltOrbit();

	/** True during active drag (mouse captured). */
	bool IsAltOrbiting() const { return bAltOrbiting; }

	/** True in hold mode (cursor visible, orbit persists). */
	bool IsAltHolding() const { return bAltHold; }

	/** True if either orbiting or holding. */
	bool IsInOrbitMode() const { return bAltOrbiting || bAltHold; }

private:
	// ── Components ─────────────────────────────────────────
	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UStaticMeshComponent> MeshComp;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USpringArmComponent> SpringArm;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UCameraComponent> Camera;

	// ── Enhanced Input actions ─────────────────────────────
	UPROPERTY()
	TObjectPtr<UInputMappingContext> InputMapping;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_MoveForward;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_MoveBackward;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_TurnLeft;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_TurnRight;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_Jump;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_Crouch;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_Fly;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_Run;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_Zoom;

	UPROPERTY()
	TObjectPtr<UInputAction> IA_Escape;

	void CreateInputActions();

	// ── Input callbacks ───────────────────────────────────
	void OnMoveForward(const FInputActionValue& Value);
	void OnMoveBackward(const FInputActionValue& Value);
	void OnTurnLeft(const FInputActionValue& Value);
	void OnTurnRight(const FInputActionValue& Value);
	void OnJump(const FInputActionValue& Value);
	void OnCrouch(const FInputActionValue& Value);
	void OnFly(const FInputActionValue& Value);
	void OnRun(const FInputActionValue& Value);
	void OnZoom(const FInputActionValue& Value);
	void OnEscape(const FInputActionValue& Value);

	// ── Movement state ────────────────────────────────────
	bool bForward     = false;
	bool bBackward    = false;
	bool bTurnLeft    = false;
	bool bTurnRight   = false;
	bool bJump        = false;
	bool bCrouch      = false;
	bool bRunning     = false;
	bool bFlyToggled  = false;  // true on frame fly was toggled
	bool bFlying      = false;

	// ── Normal camera state ──────────────────────────────
	float AvatarYaw     = 0.0f;   // Godot-space radians
	float CameraYaw     = 0.0f;   // Radians
	float CameraPitch        = -0.35f; // Radians (slightly looking down)
	float CameraDistance     = 600.0f; // cm

	static constexpr float DefaultCameraPitch = -0.35f;

	static constexpr float TurnRate          = 2.5f;   // rad/s
	static constexpr float CameraReturnSpeed = 3.0f;   // lerp factor
	static constexpr float MinZoom           = 50.0f;  // cm
	static constexpr float MaxZoom           = 5000.0f; // cm

	// ── Alt-orbit state ──────────────────────────────────
	bool bAltOrbiting = false;   // Active drag (mouse captured)
	bool bAltHold     = false;   // Released but orbit persists

	FVector OrbitFocus    = FVector::ZeroVector;
	float   OrbitYaw      = 0.0f;   // Radians, horizontal angle
	float   OrbitPitch    = 0.0f;   // Radians, elevation
	float   OrbitDistance  = 600.0f; // cm

	FVector SavedTargetOffset = FVector::ZeroVector;

	static constexpr float OrbitSensitivity  = 0.003f;  // rad/mouse-unit
	static constexpr float MinOrbitDistance   = 10.0f;   // cm
	static constexpr float MaxOrbitDistance   = 50000.0f; // cm (500m)

	/** Read mouse delta and update orbit yaw/pitch/zoom during active drag. */
	void TickOrbitDrag();

	/** Position the camera using current orbit spherical coords. */
	void TickOrbitCamera();

	// ── Input sending ─────────────────────────────────────
	void SendInputMove();

	UPROPERTY()
	TObjectPtr<USLWebSocketServer> WebSocket;

	float InputSendTimer  = 0.0f;
	bool  bInputDirty     = false;

	static constexpr float InputSendInterval = 0.05f; // 20 Hz
};
