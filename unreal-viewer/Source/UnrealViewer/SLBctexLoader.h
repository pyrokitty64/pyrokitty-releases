#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Engine/Texture2D.h"
#include "SLBctexLoader.generated.h"

/**
 * Loads .bctex files (BC1/BC3 pre-compressed textures) into UTexture2D.
 *
 * Format: 32-byte header + raw BC block data, mips largest-to-smallest.
 *   magic:    u32 = 0x42435458 ('BCTX')
 *   version:  u32 = 1
 *   width:    u32
 *   height:   u32
 *   format:   u32 (0=BC1/DXT1, 1=BC3/DXT5)
 *   mipCount: u32
 *   flags:    u32 (bit 0 = has_alpha)
 *   dataSize: u32
 */
UCLASS()
class UNREALVIEWER_API USLBctexLoader : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	/** Load a .bctex file and return a UTexture2D. Cached by textureId. */
	UTexture2D* LoadTexture(const FString& TextureId, const FString& BctexPath);

	/** Get a previously cached texture, or nullptr. */
	UTexture2D* GetCachedTexture(const FString& TextureId) const;

	int32 GetCacheSize() const { return TextureCache.Num(); }

private:
	static constexpr uint32 BCTEX_MAGIC = 0x42435458;
	static constexpr uint32 BCTEX_VERSION = 1;
	static constexpr uint32 BCTEX_HEADER_SIZE = 32;

	UPROPERTY()
	TMap<FString, TObjectPtr<UTexture2D>> TextureCache;

	TSet<FString> FailedTextures;
};
