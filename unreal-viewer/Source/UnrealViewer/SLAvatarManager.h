#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "SLAvatarManager.generated.h"

class USLWebSocketServer;
class ASLAvatarPawn;

/** Per-avatar interpolation state (all in Godot space). */
struct FAvatarInterpState
{
	FVector CurrentPos = FVector::ZeroVector;
	FQuat   CurrentRot = FQuat::Identity;
	FVector TargetPos  = FVector::ZeroVector;
	FQuat   TargetRot  = FQuat::Identity;
	FVector Velocity   = FVector::ZeroVector;
	float   Age        = 0.0f;
};

/**
 * Manages avatar lifecycle: create, update, interpolate, destroy.
 * Blue box placeholders for all avatars; self avatar is the possessed ASLAvatarPawn.
 */
UCLASS()
class UNREALVIEWER_API USLAvatarManager : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

private:
	// ── Message handlers ───────────────────────────────────
	void HandleSelfId(const TSharedPtr<FJsonObject>& Json);
	void HandleAvatarCreate(const TSharedPtr<FJsonObject>& Json);
	void HandleAvatarUpdateBatch(const TSharedPtr<FJsonObject>& Json);
	void HandleAvatarKill(const TSharedPtr<FJsonObject>& Json);
	void HandleRegionChange();

	// ── Tick ───────────────────────────────────────────────
	bool Tick(float DeltaTime);
	void InterpolateAvatar(const FString& Id, FAvatarInterpState& State, float DeltaTime);

	// ── Helpers ────────────────────────────────────────────
	AActor* SpawnOtherAvatar(const FString& Id, const FVector& GodotPos, const FQuat& GodotRot);
	void RegisterSelfPawn();

	// ── Shared resources ──────────────────────────────────
	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;

	UPROPERTY()
	TObjectPtr<UMaterialInstanceDynamic> BlueMaterial;

	void CreateSharedResources();

	// ── State ─────────────────────────────────────────────
	UPROPERTY()
	TObjectPtr<USLWebSocketServer> WebSocket;

	/** UUID -> spawned actor (includes self pawn) */
	UPROPERTY()
	TMap<FString, TObjectPtr<AActor>> Avatars;

	/** UUID -> interpolation state */
	TMap<FString, FAvatarInterpState> InterpStates;

	FString SelfAvatarId;

	/** Cached ref to the self avatar pawn */
	UPROPERTY()
	TObjectPtr<ASLAvatarPawn> SelfPawn;

	FDelegateHandle MessageHandle;
	FTSTicker::FDelegateHandle TickHandle;

	// ── Interpolation constants ───────────────────────────
	static constexpr float PHASE_OUT_TIME     = 2.0f;
	static constexpr float MAX_EXTRAP_TIME    = 3.0f;
	static constexpr float DAMPING_TAU        = 0.06f;
	static constexpr float PELVIS_LAG_TIME    = 0.4f;
};
