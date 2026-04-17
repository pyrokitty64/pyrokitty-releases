#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "InputActionValue.h"
#include "SLPlayerController.generated.h"

class UInputAction;
class UInputMappingContext;
class USLWebSocketServer;
class USLObjectManager;
class UStaticMeshComponent;

/**
 * Player controller — shows cursor, doesn't capture mouse.
 * Handles:
 *  - Left-click picking: per-triangle line trace -> UUID lookup -> object_touch to Electron.
 *  - Alt+left-click: start alt-orbit camera around the clicked point.
 *  - Mouse release during orbit: transition to orbit hold.
 */
UCLASS()
class UNREALVIEWER_API ASLPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	ASLPlayerController();

	virtual void BeginPlay() override;

protected:
	virtual void SetupInputComponent() override;

private:
	void OnClick();
	void OnClickReleased();

	/** Resolve a triangle index to the material section (SL face) index. */
	static int32 GetSectionFromTriangle(const UStaticMeshComponent* MeshComp, int32 TriIndex);

	// ── Input ─────────────────────────────────────────────
	UPROPERTY()
	TObjectPtr<UInputAction> IA_Click;

	UPROPERTY()
	TObjectPtr<UInputMappingContext> ClickMapping;

	// ── Subsystem refs (set in BeginPlay) ─────────────────
	UPROPERTY()
	TObjectPtr<USLWebSocketServer> WebSocket;

	UPROPERTY()
	TObjectPtr<USLObjectManager> ObjectManager;
};
