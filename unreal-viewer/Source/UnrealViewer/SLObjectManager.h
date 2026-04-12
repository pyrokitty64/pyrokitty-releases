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
 * Handles: object_render, object_update_batch, object_kill, region_change
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
	void HandleRegionChange();

	/** Spawn an actor for an object with the given mesh and transform. */
	AActor* SpawnObjectActor(const FString& Uuid, UStaticMesh* Mesh, const FTransform& Transform);

	/** Attach a child actor to its parent. */
	void AttachToParent(AActor* Child, const FString& ChildUuid, const FString& ParentUuid);

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

	/** Child UUID -> parent UUID (for deferred attachment) */
	TMap<FString, FString> ChildToParent;

	/** Delegate handle for message subscription */
	FDelegateHandle MessageHandle;

	/** Self avatar UUID — set from self_id message */
	FString SelfAvatarId;

	/** Whether we've moved the camera to the avatar yet */
	bool bCameraPositioned = false;

	// Stats
	int32 SpawnedCount = 0;
	int32 SkippedNoMeshCount = 0;
};
