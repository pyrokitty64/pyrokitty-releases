#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "SLSceneSetup.generated.h"

/**
 * Sets up the basic scene environment on startup — directional light, sky, fog.
 * The Entry map is empty, so we create everything at runtime.
 */
UCLASS()
class UNREALVIEWER_API USLSceneSetup : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;

private:
	void SetupScene();
	bool bSceneReady = false;
	FDelegateHandle MessageHandle;
};
