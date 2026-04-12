#pragma once

#include "CoreMinimal.h"
#include "Math/Vector.h"
#include "Math/Quat.h"

/**
 * Coordinate conversion: Godot-space -> Unreal-space.
 *
 * Godot:  X=Right, Y=Up,  Z=-Forward (right-handed, meters)
 * Unreal: X=Forward, Y=Right, Z=Up    (left-handed, centimeters)
 *
 * Position: multiply by 100 for meters->cm
 * Rotation: negate W for handedness flip
 * Scale:    unitless, no 100x
 */
namespace SLCoord
{
	/** Convert Godot position [X,Y,Z] to Unreal FVector (meters -> centimeters). */
	FORCEINLINE FVector Position(double Gx, double Gy, double Gz)
	{
		return FVector(-Gz * 100.0, Gx * 100.0, Gy * 100.0);
	}

	/** Convert Godot quaternion [X,Y,Z,W] to Unreal FQuat (negate W for handedness). */
	FORCEINLINE FQuat Rotation(double Gx, double Gy, double Gz, double Gw)
	{
		return FQuat(-Gz, Gx, Gy, -Gw);
	}

	/**
	 * Convert Godot scale [X,Y,Z] to Unreal FVector.
	 * Axis swap only — no 100x. glTFRuntime's SceneScale (default 100) already
	 * converts GLB mesh vertices from meters to centimeters.
	 */
	FORCEINLINE FVector Scale(double Gx, double Gy, double Gz)
	{
		return FVector(Gz, Gx, Gy);
	}

	/** Extract position from a JSON object with "position" array [x,y,z]. Returns zero if missing. */
	inline FVector PositionFromJson(const TSharedPtr<FJsonObject>& Json, const FString& FieldName = TEXT("position"))
	{
		const TArray<TSharedPtr<FJsonValue>>* Arr;
		if (Json->TryGetArrayField(FieldName, Arr) && Arr->Num() >= 3)
		{
			return Position((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
		}
		return FVector::ZeroVector;
	}

	/** Extract rotation from a JSON object with "rotation" array [x,y,z,w]. Returns identity if missing. */
	inline FQuat RotationFromJson(const TSharedPtr<FJsonObject>& Json, const FString& FieldName = TEXT("rotation"))
	{
		const TArray<TSharedPtr<FJsonValue>>* Arr;
		if (Json->TryGetArrayField(FieldName, Arr) && Arr->Num() >= 4)
		{
			return Rotation((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber(), (*Arr)[3]->AsNumber());
		}
		return FQuat::Identity;
	}

	/** Extract scale from a JSON object with "scale" array [x,y,z]. Returns (1,1,1) if missing. */
	inline FVector ScaleFromJson(const TSharedPtr<FJsonObject>& Json, const FString& FieldName = TEXT("scale"))
	{
		const TArray<TSharedPtr<FJsonValue>>* Arr;
		if (Json->TryGetArrayField(FieldName, Arr) && Arr->Num() >= 3)
		{
			return Scale((*Arr)[0]->AsNumber(), (*Arr)[1]->AsNumber(), (*Arr)[2]->AsNumber());
		}
		return FVector::OneVector;
	}
}
