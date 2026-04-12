#include "SLGameMode.h"
#include "SLPlayerController.h"
#include "SLSpectatorPawn.h"

ASLGameMode::ASLGameMode()
{
	DefaultPawnClass = ASLSpectatorPawn::StaticClass();
	PlayerControllerClass = ASLPlayerController::StaticClass();
}
