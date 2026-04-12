#include "SLSceneSetup.h"
#include "SLWebSocketServer.h"
#include "UnrealViewerModule.h"
#include "Engine/GameInstance.h"
#include "Engine/DirectionalLight.h"
#include "Engine/SkyLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Engine/World.h"

void USLSceneSetup::Initialize(FSubsystemCollectionBase& Collection)
{
	Collection.InitializeDependency<USLWebSocketServer>();
	Super::Initialize(Collection);

	// Listen for the first message to know the world is ready
	USLWebSocketServer* WebSocket = GetGameInstance()->GetSubsystem<USLWebSocketServer>();
	if (WebSocket)
	{
		MessageHandle = WebSocket->OnJsonMessage.AddLambda(
			[this, WebSocket](const FString& Type, const TSharedPtr<FJsonObject>& Json)
			{
				if (!bSceneReady)
				{
					SetupScene();
					bSceneReady = true;
					WebSocket->OnJsonMessage.Remove(MessageHandle);
				}
			}
		);
	}

	// Also try immediately in case world is already loaded
	SetupScene();
}

void USLSceneSetup::SetupScene()
{
	UWorld* World = GetGameInstance()->GetWorld();
	if (!World)
	{
		return;
	}

	if (bSceneReady)
	{
		return;
	}

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	// Sky atmosphere — this is what makes the sky blue
	{
		AActor* SkyAtmo = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity, Params);
		if (SkyAtmo)
		{
			USkyAtmosphereComponent* Atmo = NewObject<USkyAtmosphereComponent>(SkyAtmo, TEXT("SkyAtmosphere"));
			SkyAtmo->SetRootComponent(Atmo);
			Atmo->RegisterComponent();
			UE_LOG(LogSLViewer, Log, TEXT("[SceneSetup] Spawned sky atmosphere"));
		}
	}

	// Directional light (sun) — must be marked as atmosphere sun for the sky to work
	{
		ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector::ZeroVector, FRotator(-45.0f, -30.0f, 0.0f), Params);
		if (Sun)
		{
			UDirectionalLightComponent* LightComp = Cast<UDirectionalLightComponent>(Sun->GetLightComponent());
			if (LightComp)
			{
				LightComp->SetIntensity(10.0f);
				LightComp->SetLightColor(FLinearColor(1.0f, 0.95f, 0.85f));
				LightComp->SetAtmosphereSunLight(true);
				LightComp->SetAtmosphereSunLightIndex(0);
				LightComp->SetCastShadows(true);
			}
			UE_LOG(LogSLViewer, Log, TEXT("[SceneSetup] Spawned directional light (sun)"));
		}
	}

	// Sky light (ambient fill from sky)
	{
		ASkyLight* Sky = World->SpawnActor<ASkyLight>(FVector::ZeroVector, FRotator::ZeroRotator, Params);
		if (Sky)
		{
			USkyLightComponent* SkyComp = Sky->GetLightComponent();
			if (SkyComp)
			{
				SkyComp->SetIntensity(1.0f);
				SkyComp->bRealTimeCapture = true;
				SkyComp->RecaptureSky();
			}
			UE_LOG(LogSLViewer, Log, TEXT("[SceneSetup] Spawned sky light"));
		}
	}

	// Exponential height fog
	{
		AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>(FVector::ZeroVector, FRotator::ZeroRotator, Params);
		if (Fog)
		{
			UExponentialHeightFogComponent* FogComp = Fog->GetComponent();
			if (FogComp)
			{
				FogComp->SetFogDensity(0.001f);
				FogComp->SetFogInscatteringColor(FLinearColor(0.6f, 0.7f, 0.9f));
				FogComp->SetVolumetricFog(true);
			}
			UE_LOG(LogSLViewer, Log, TEXT("[SceneSetup] Spawned exponential height fog"));
		}
	}

	bSceneReady = true;
	UE_LOG(LogSLViewer, Log, TEXT("[SceneSetup] Scene environment ready"));
}
