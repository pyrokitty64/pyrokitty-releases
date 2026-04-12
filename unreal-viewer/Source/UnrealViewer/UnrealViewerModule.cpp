#include "UnrealViewerModule.h"
#include "Modules/ModuleManager.h"
#include "UObject/ConstructorHelpers.h"
#include "SLMaterialRefs.h"

DEFINE_LOG_CATEGORY(LogSLViewer);

void FUnrealViewerModule::StartupModule()
{
	UE_LOG(LogSLViewer, Log, TEXT("UnrealViewer module starting up"));
}

void FUnrealViewerModule::ShutdownModule()
{
	UE_LOG(LogSLViewer, Log, TEXT("UnrealViewer module shutting down"));
}

IMPLEMENT_PRIMARY_GAME_MODULE(FUnrealViewerModule, UnrealViewer, "UnrealViewer");
