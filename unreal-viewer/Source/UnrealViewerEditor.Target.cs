using UnrealBuildTool;

public class UnrealViewerEditorTarget : TargetRules
{
	public UnrealViewerEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V6;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("UnrealViewer");
	}
}
