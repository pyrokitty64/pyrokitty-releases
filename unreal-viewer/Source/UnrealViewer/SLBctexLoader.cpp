#include "SLBctexLoader.h"
#include "UnrealViewerModule.h"
#include "Misc/FileHelper.h"
#include "TextureResource.h"

UTexture2D* USLBctexLoader::LoadTexture(const FString& TextureId, const FString& BctexPath)
{
	if (TObjectPtr<UTexture2D>* Found = TextureCache.Find(TextureId))
	{
		return *Found;
	}

	if (FailedTextures.Contains(TextureId))
	{
		return nullptr;
	}

	// Read entire file
	TArray<uint8> FileData;
	if (!FFileHelper::LoadFileToArray(FileData, *BctexPath))
	{
		FailedTextures.Add(TextureId);
		return nullptr;
	}

	if (FileData.Num() < static_cast<int32>(BCTEX_HEADER_SIZE))
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[BctexLoader] File too small: %s"), *BctexPath);
		FailedTextures.Add(TextureId);
		return nullptr;
	}

	// Parse header (little-endian)
	const uint8* Ptr = FileData.GetData();
	const uint32 Magic     = *reinterpret_cast<const uint32*>(Ptr + 0);
	const uint32 Version   = *reinterpret_cast<const uint32*>(Ptr + 4);
	const uint32 Width     = *reinterpret_cast<const uint32*>(Ptr + 8);
	const uint32 Height    = *reinterpret_cast<const uint32*>(Ptr + 12);
	const uint32 Format    = *reinterpret_cast<const uint32*>(Ptr + 16);  // 0=BC1, 1=BC3
	const uint32 MipCount  = *reinterpret_cast<const uint32*>(Ptr + 20);
	// flags at offset 24, dataSize at offset 28

	if (Magic != BCTEX_MAGIC || Version != BCTEX_VERSION)
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[BctexLoader] Bad magic/version: %s"), *BctexPath);
		FailedTextures.Add(TextureId);
		return nullptr;
	}

	if (Width == 0 || Height == 0 || MipCount == 0)
	{
		FailedTextures.Add(TextureId);
		return nullptr;
	}

	const EPixelFormat PixelFormat = (Format == 0) ? PF_DXT1 : PF_DXT5;
	const uint32 BytesPerBlock = (Format == 0) ? 8 : 16;

	// Create texture
	UTexture2D* Texture = UTexture2D::CreateTransient(Width, Height, PixelFormat, *TextureId);
	if (!Texture)
	{
		FailedTextures.Add(TextureId);
		return nullptr;
	}

	Texture->SRGB = true;
	Texture->NeverStream = true;

	// Fill mip data
	FTexturePlatformData* PlatformData = Texture->GetPlatformData();

	// Remove default mip and rebuild with correct count
	PlatformData->Mips.Empty();

	uint32 DataOffset = BCTEX_HEADER_SIZE;
	uint32 MipW = Width;
	uint32 MipH = Height;

	for (uint32 Mip = 0; Mip < MipCount; ++Mip)
	{
		const uint32 BlocksX = FMath::Max(1u, (MipW + 3) / 4);
		const uint32 BlocksY = FMath::Max(1u, (MipH + 3) / 4);
		const uint32 MipSize = BlocksX * BlocksY * BytesPerBlock;

		if (DataOffset + MipSize > static_cast<uint32>(FileData.Num()))
		{
			UE_LOG(LogSLViewer, Warning, TEXT("[BctexLoader] Truncated mip %d: %s"), Mip, *TextureId.Left(8));
			break;
		}

		FTexture2DMipMap* NewMip = new FTexture2DMipMap();
		PlatformData->Mips.Add(NewMip);
		NewMip->SizeX = MipW;
		NewMip->SizeY = MipH;

		NewMip->BulkData.Lock(LOCK_READ_WRITE);
		void* MipData = NewMip->BulkData.Realloc(MipSize);
		FMemory::Memcpy(MipData, FileData.GetData() + DataOffset, MipSize);
		NewMip->BulkData.Unlock();

		DataOffset += MipSize;
		MipW = FMath::Max(1u, MipW >> 1);
		MipH = FMath::Max(1u, MipH >> 1);
	}

	Texture->UpdateResource();

	TextureCache.Add(TextureId, Texture);

	if (TextureCache.Num() <= 5 || (TextureCache.Num() % 200 == 0))
	{
		UE_LOG(LogSLViewer, Log, TEXT("[BctexLoader] Loaded #%d: %s %dx%d %s %d mips"),
			TextureCache.Num(), *TextureId.Left(8), Width, Height,
			Format == 0 ? TEXT("BC1") : TEXT("BC3"), MipCount);
	}

	return Texture;
}

UTexture2D* USLBctexLoader::GetCachedTexture(const FString& TextureId) const
{
	if (const TObjectPtr<UTexture2D>* Found = TextureCache.Find(TextureId))
	{
		return *Found;
	}
	return nullptr;
}
