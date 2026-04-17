#include "SLGlbLoader.h"
#include "UnrealViewerModule.h"
#include "glTFRuntimeFunctionLibrary.h"
#include "Misc/Paths.h"

// ─── Asset parsing (cached) ───────────────────────────────

UglTFRuntimeAsset* USLGlbLoader::EnsureAsset(const FString& MeshId, const FString& GlbPath)
{
	// Return cached asset
	if (TObjectPtr<UglTFRuntimeAsset>* Found = AssetCache.Find(MeshId))
	{
		return *Found;
	}

	if (FailedMeshes.Contains(MeshId))
	{
		return nullptr;
	}

	if (!FPaths::FileExists(GlbPath))
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[GlbLoader] File not found: %s (meshId=%s)"), *GlbPath, *MeshId.Left(8));
		FailedMeshes.Add(MeshId);
		return nullptr;
	}

	FglTFRuntimeConfig LoaderConfig;
	UglTFRuntimeAsset* Asset = UglTFRuntimeFunctionLibrary::glTFLoadAssetFromFilename(
		GlbPath, false, LoaderConfig);

	if (!Asset)
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[GlbLoader] Failed to parse GLB: %s (meshId=%s)"), *GlbPath, *MeshId.Left(8));
		FailedMeshes.Add(MeshId);
		return nullptr;
	}

	if (Asset->GetNumMeshes() <= 0)
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[GlbLoader] GLB has no meshes: %s (meshId=%s)"), *GlbPath, *MeshId.Left(8));
		FailedMeshes.Add(MeshId);
		return nullptr;
	}

	AssetCache.Add(MeshId, Asset);
	return Asset;
}

// ─── Visual mesh (cached, no complex collision) ───────────

UStaticMesh* USLGlbLoader::LoadMesh(const FString& MeshId, const FString& GlbPath)
{
	if (TObjectPtr<UStaticMesh>* Found = MeshCache.Find(MeshId))
	{
		return *Found;
	}

	UglTFRuntimeAsset* Asset = EnsureAsset(MeshId, GlbPath);
	if (!Asset)
	{
		return nullptr;
	}

	FglTFRuntimeStaticMeshConfig MeshConfig;
	MeshConfig.bAllowCPUAccess = true; // CPU-side vertex data needed for per-triangle line trace picking
	UStaticMesh* Mesh = Asset->LoadStaticMesh(0, MeshConfig);
	if (!Mesh)
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[GlbLoader] Failed to load static mesh 0: meshId=%s"), *MeshId.Left(8));
		FailedMeshes.Add(MeshId);
		return nullptr;
	}

	MeshCache.Add(MeshId, Mesh);

	if (MeshCache.Num() <= 10 || (MeshCache.Num() % 100 == 0))
	{
		UE_LOG(LogSLViewer, Log, TEXT("[GlbLoader] Loaded mesh #%d: meshId=%s"),
			MeshCache.Num(), *MeshId.Left(8));
	}

	return Mesh;
}

// ─── Mesh with per-triangle collision (not cached) ────────

UStaticMesh* USLGlbLoader::LoadMeshWithCollision(const FString& MeshId, const FString& GlbPath, UStaticMeshComponent* MeshComponent)
{
	UglTFRuntimeAsset* Asset = EnsureAsset(MeshId, GlbPath);
	if (!Asset)
	{
		return nullptr;
	}

	FglTFRuntimeStaticMeshConfig MeshConfig;
	MeshConfig.bAllowCPUAccess = true;
	MeshConfig.CollisionComplexity = ECollisionTraceFlag::CTF_UseComplexAsSimple;
	MeshConfig.Outer = MeshComponent;
	// Skip glTFRuntime's internal cache — we need a fresh mesh per component
	// because the collision is cooked with this specific component as Outer.
	MeshConfig.CacheMode = EglTFRuntimeCacheMode::None;

	UStaticMesh* Mesh = Asset->LoadStaticMesh(0, MeshConfig);
	if (!Mesh)
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[GlbLoader] Failed to load collision mesh: meshId=%s"), *MeshId.Left(8));
		return nullptr;
	}

	return Mesh;
}

// ─── Cache query ──────────────────────────────────────────

UStaticMesh* USLGlbLoader::GetCachedMesh(const FString& MeshId) const
{
	if (const TObjectPtr<UStaticMesh>* Found = MeshCache.Find(MeshId))
	{
		return *Found;
	}
	return nullptr;
}
