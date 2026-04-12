#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Dom/JsonObject.h"
#include "SLObjectManager.generated.h"

class USLWebSocketServer;
class USLGlbLoader;

/**
 * Core object lifecycle manager — spawns, updates, and destroys actors
 * in response to WebSocket messages from Electron.
 *
 * Coordinate handling (mirroring Godot's object_manager.gd):
 *  - Positions arrive pre-converted to Godot space (axis-swapped from SL)
 *  - Root prims: region-local position + region offset from terrain_ready messages
 *  - Child prims: parent-relative offset — world pos = parent.pos + parent.rot * offset
 *  - All converted Godot→Unreal via SLCoord before spawning
 */
UCLASS()
class UNREALVIEWER_API USLObjectManager : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	int32 GetObjectCount() const { return Objects.Num(); }

private:
	/** Message handlers */
	void HandleObjectRender(const TSharedPtr<FJsonObject>& Json);
	void HandleObjectUpdateBatch(const TSharedPtr<FJsonObject>& Json);
	void HandleObjectKill(const TSharedPtr<FJsonObject>& Json);
	void HandleAvatarUpdate(const TSharedPtr<FJsonObject>& Json);
	void HandleTerrainReady(const TSharedPtr<FJsonObject>& Json);
	void HandleRegionChange();

	/** Compute world-space Godot position/rotation for an object, then convert to Unreal. */
	FTransform ComputeWorldTransform(const TSharedPtr<FJsonObject>& Json, const FString& ParentUuid);

	/** Spawn an actor for an object with the given mesh and transform. */
	AActor* SpawnObjectActor(const FString& Uuid, UStaticMesh* Mesh, const FTransform& Transform);

	/** Resolve any children waiting for this parent to arrive. */
	void ResolvePendingChildren(const FString& ParentUuid);

	/** Destroy an object and all its children recursively. */
	void DestroyObject(const FString& Uuid);

	/** Clear entire scene. */
	void ClearAll();

	// References to sibling subsystems
	UPROPERTY()
	TObjectPtr<USLWebSocketServer> WebSocket;

	UPROPERTY()
	TObjectPtr<USLGlbLoader> GlbLoader;

	/** UUID -> spawned actor */
	UPROPERTY()
	TMap<FString, TObjectPtr<AActor>> Objects;

	/** Parent UUID -> child UUIDs waiting for parent to arrive */
	TMap<FString, TArray<FString>> PendingChildren;

	/** Child UUID -> stored JSON (for deferred spawn when parent arrives) */
	TMap<FString, TSharedPtr<FJsonObject>> PendingChildJson;

	/** UUID -> stored Godot-space position (for computing child world positions) */
	TMap<FString, FVector> GodotPositions;

	/** UUID -> stored Godot-space rotation */
	TMap<FString, FQuat> GodotRotations;

	/** Region cacheID -> offset in Godot-space (X, -Z from SL) */
	TMap<FString, FVector> RegionOffsets;

	/** UUID -> region offset stored at creation */
	TMap<FString, FVector> ObjectRegionOffset;

	/** Delegate handle for message subscription */
	FDelegateHandle MessageHandle;

	/** Self avatar UUID */
	FString SelfAvatarId;

	/** Whether we've moved the camera to the avatar yet */
	bool bCameraPositioned = false;

	// Stats
	int32 SpawnedCount = 0;
	int32 SkippedNoMeshCount = 0;
};
