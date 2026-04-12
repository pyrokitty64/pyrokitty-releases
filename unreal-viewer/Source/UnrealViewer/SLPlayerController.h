#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "SLPlayerController.generated.h"

/**
 * Player controller — shows cursor, doesn't capture mouse.
 * Right-click + drag to look around, WASD to fly.
 */
UCLASS()
class UNREALVIEWER_API ASLPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	virtual void BeginPlay() override;
};
