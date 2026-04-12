#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "SLGameMode.generated.h"

/**
 * Minimal game mode — spectator pawn with visible cursor, no mouse capture.
 */
UCLASS()
class UNREALVIEWER_API ASLGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	ASLGameMode();
};
