#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "Materials/MaterialInterface.h"
#include "SLMaterialRefs.generated.h"

/**
 * Dummy UObject whose constructor holds ConstructorHelpers references to
 * glTFRuntime materials. This forces the cooker to include them in
 * packaged builds (LoadObject at runtime is invisible to the cook).
 */
UCLASS()
class USLMaterialRefs : public UObject
{
	GENERATED_BODY()

public:
	USLMaterialRefs();

	UPROPERTY()
	TObjectPtr<UMaterialInterface> MatOpaque;
	UPROPERTY()
	TObjectPtr<UMaterialInterface> MatMasked;
	UPROPERTY()
	TObjectPtr<UMaterialInterface> MatTranslucent;
};
