using UnrealBuildTool;

public class UnrealViewerTarget : TargetRules
{
	public UnrealViewerTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V6;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("UnrealViewer");
	}
}
