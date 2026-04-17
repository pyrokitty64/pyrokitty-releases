#include "SLGameMode.h"
#include "SLPlayerController.h"
#include "SLAvatarPawn.h"

ASLGameMode::ASLGameMode()
{
	DefaultPawnClass = ASLAvatarPawn::StaticClass();
	PlayerControllerClass = ASLPlayerController::StaticClass();
}
