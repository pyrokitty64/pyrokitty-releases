#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "glTFRuntimeAsset.h"
#include "glTFRuntimeParser.h"
#include "SLGlbLoader.generated.h"

/**
 * Loads GLB files via glTFRuntime and caches the resulting static meshes.
 * Keyed by meshId (SL asset UUID) — the same mesh is reused by many objects.
 */
UCLASS()
class UNREALVIEWER_API USLGlbLoader : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	/**
	 * Load a GLB file and return the first static mesh. Cached by meshId.
	 * Returns nullptr if the file doesn't exist or fails to load.
	 */
	UStaticMesh* LoadMesh(const FString& MeshId, const FString& GlbPath);

	/** Get a previously cached mesh, or nullptr. */
	UStaticMesh* GetCachedMesh(const FString& MeshId) const;

	/** Number of cached meshes. */
	int32 GetCacheSize() const { return MeshCache.Num(); }

private:
	/** meshId -> loaded UStaticMesh */
	UPROPERTY()
	TMap<FString, TObjectPtr<UStaticMesh>> MeshCache;

	/** meshId -> glTFRuntime asset (kept alive so meshes stay valid) */
	UPROPERTY()
	TMap<FString, TObjectPtr<UglTFRuntimeAsset>> AssetCache;

	/** Set of meshIds that failed to load — don't retry. */
	TSet<FString> FailedMeshes;
};
