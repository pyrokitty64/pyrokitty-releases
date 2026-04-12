#include "SLGlbLoader.h"
#include "UnrealViewerModule.h"
#include "glTFRuntimeFunctionLibrary.h"
#include "Misc/Paths.h"

UStaticMesh* USLGlbLoader::LoadMesh(const FString& MeshId, const FString& GlbPath)
{
	// Check cache first
	if (TObjectPtr<UStaticMesh>* Found = MeshCache.Find(MeshId))
	{
		return *Found;
	}

	// Don't retry known failures
	if (FailedMeshes.Contains(MeshId))
	{
		return nullptr;
	}

	// Verify file exists
	if (!FPaths::FileExists(GlbPath))
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[GlbLoader] File not found: %s (meshId=%s)"), *GlbPath, *MeshId.Left(8));
		FailedMeshes.Add(MeshId);
		return nullptr;
	}

	// Load GLB via glTFRuntime
	// SceneScale=100 (default): converts GLB vertices from meters to centimeters.
	// Our Position() also multiplies by 100, but that's for positions not mesh vertices.
	// Scale is axis-swap only — glTFRuntime makes the mesh 1m at scale=1.
	FglTFRuntimeConfig LoaderConfig;

	UglTFRuntimeAsset* Asset = UglTFRuntimeFunctionLibrary::glTFLoadAssetFromFilename(
		GlbPath,
		false, // not relative to Content
		LoaderConfig
	);

	if (!Asset)
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[GlbLoader] Failed to parse GLB: %s (meshId=%s)"), *GlbPath, *MeshId.Left(8));
		FailedMeshes.Add(MeshId);
		return nullptr;
	}

	// Keep the asset alive (UStaticMesh references data owned by it)
	AssetCache.Add(MeshId, Asset);

	// Load first mesh — use embedded materials from the GLB for now
	FglTFRuntimeStaticMeshConfig MeshConfig;

	const int32 NumMeshes = Asset->GetNumMeshes();
	if (NumMeshes <= 0)
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[GlbLoader] GLB has no meshes: %s (meshId=%s)"), *GlbPath, *MeshId.Left(8));
		FailedMeshes.Add(MeshId);
		return nullptr;
	}

	UStaticMesh* Mesh = Asset->LoadStaticMesh(0, MeshConfig);
	if (!Mesh)
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[GlbLoader] Failed to load static mesh 0: %s (meshId=%s)"), *GlbPath, *MeshId.Left(8));
		FailedMeshes.Add(MeshId);
		return nullptr;
	}

	MeshCache.Add(MeshId, Mesh);

	if (MeshCache.Num() <= 10 || (MeshCache.Num() % 100 == 0))
	{
		UE_LOG(LogSLViewer, Log, TEXT("[GlbLoader] Loaded mesh #%d: meshId=%s (%d meshes in GLB)"),
			MeshCache.Num(), *MeshId.Left(8), NumMeshes);
	}

	return Mesh;
}

UStaticMesh* USLGlbLoader::GetCachedMesh(const FString& MeshId) const
{
	if (const TObjectPtr<UStaticMesh>* Found = MeshCache.Find(MeshId))
	{
		return *Found;
	}
	return nullptr;
}
