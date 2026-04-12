using UnrealBuildTool;

public class UnrealViewer : ModuleRules
{
	public UnrealViewer(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"Json",
			"JsonUtilities",
			"WebSocketNetworking",
			"glTFRuntime"
		});
	}
}
