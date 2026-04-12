#include "SLPlayerController.h"

void ASLPlayerController::BeginPlay()
{
	Super::BeginPlay();

	// Show mouse cursor, don't capture
	bShowMouseCursor = true;
	SetInputMode(FInputModeGameAndUI()
		.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock)
		.SetHideCursorDuringCapture(false));
}
