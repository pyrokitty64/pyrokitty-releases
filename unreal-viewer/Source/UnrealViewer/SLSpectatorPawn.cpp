#include "SLSpectatorPawn.h"
#include "GameFramework/FloatingPawnMovement.h"

ASLSpectatorPawn::ASLSpectatorPawn()
{
	// Fast fly speed for navigating SL scenes (in cm/s)
	if (UFloatingPawnMovement* Movement = Cast<UFloatingPawnMovement>(GetMovementComponent()))
	{
		Movement->MaxSpeed = 2000.0f;     // 20 m/s
		Movement->Acceleration = 4000.0f;
		Movement->Deceleration = 8000.0f;
	}
}
