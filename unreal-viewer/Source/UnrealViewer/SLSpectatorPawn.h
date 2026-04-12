#pragma once

#include "CoreMinimal.h"
#include "GameFramework/SpectatorPawn.h"
#include "SLSpectatorPawn.generated.h"

/**
 * Flying spectator pawn — no collision, free movement.
 * Positioned at the avatar's location when self_id arrives.
 */
UCLASS()
class UNREALVIEWER_API ASLSpectatorPawn : public ASpectatorPawn
{
	GENERATED_BODY()

public:
	ASLSpectatorPawn();
};
