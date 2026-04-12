#include "SLMaterialRefs.h"
#include "UObject/ConstructorHelpers.h"

USLMaterialRefs::USLMaterialRefs()
{
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> OpaqueFinder(
		TEXT("/glTFRuntime/M_glTFRuntimeBase"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> MaskedFinder(
		TEXT("/glTFRuntime/M_glTFRuntimeMasked_Inst"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> TranslucentFinder(
		TEXT("/glTFRuntime/M_glTFRuntimeTranslucent_Inst"));

	MatOpaque = OpaqueFinder.Object;
	MatMasked = MaskedFinder.Object;
	MatTranslucent = TranslucentFinder.Object;
}
