#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "glTFRuntimeAsset.h"
#include "glTFRuntimeParser.h"
#include "SLGlbLoader.generated.h"

/**
 * Loads GLB files via glTFRuntime and caches the resulting static meshes.
 * Keyed by meshId (SL asset UUID) — the same mesh is reused by many objects.
 *
 * For objects that need per-triangle collision (picking), use LoadMeshWithCollision
 * which creates a per-component mesh with Outer set correctly.
 */
UCLASS()
class UNREALVIEWER_API USLGlbLoader : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	/**
	 * Load a GLB file and return the first static mesh.
	 * Cached by meshId — fast for repeated loads.
	 * Returns nullptr if the file doesn't exist or fails to load.
	 */
	UStaticMesh* LoadMesh(const FString& MeshId, const FString& GlbPath);

	/**
	 * Load a GLB file and return a mesh with per-triangle complex collision.
	 * Outer is set to MeshComponent so collision cooking works correctly.
	 * NOT cached — each call creates a new UStaticMesh.
	 * Uses the cached glTFRuntime asset if already parsed.
	 */
	UStaticMesh* LoadMeshWithCollision(const FString& MeshId, const FString& GlbPath, UStaticMeshComponent* MeshComponent);

	/** Get a previously cached mesh, or nullptr. */
	UStaticMesh* GetCachedMesh(const FString& MeshId) const;

	/** Number of cached meshes. */
	int32 GetCacheSize() const { return MeshCache.Num(); }

private:
	/** Parse GLB and cache the asset. Returns nullptr on failure. */
	UglTFRuntimeAsset* EnsureAsset(const FString& MeshId, const FString& GlbPath);

	/** meshId -> loaded UStaticMesh (visual only, no complex collision) */
	UPROPERTY()
	TMap<FString, TObjectPtr<UStaticMesh>> MeshCache;

	/** meshId -> glTFRuntime asset (kept alive so meshes stay valid) */
	UPROPERTY()
	TMap<FString, TObjectPtr<UglTFRuntimeAsset>> AssetCache;

	/** Set of meshIds that failed to load — don't retry. */
	TSet<FString> FailedMeshes;
};
