#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "IWebSocketServer.h"
#include "INetworkingWebSocket.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "SLWebSocketServer.generated.h"

/**
 * WebSocket server subsystem — listens for Electron to connect as a client.
 * Mirrors the Godot approach: viewer runs the WS server, Electron connects.
 *
 * Launch with: UnrealEditor.exe Project.uproject -game -ws-port=9300
 */
UCLASS()
class UNREALVIEWER_API USLWebSocketServer : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	/** Send a JSON string to the connected Electron client. */
	void SendMessage(const FString& JsonString);

	/** Send a JSON object to the connected Electron client. */
	void SendJson(const TSharedRef<FJsonObject>& JsonObject);

	/** True when Electron is connected. */
	bool IsClientConnected() const { return ClientSocket != nullptr; }

	/** Delegate fired when a parsed JSON message arrives. */
	DECLARE_MULTICAST_DELEGATE_TwoParams(FOnJsonMessage, const FString& /*Type*/, const TSharedPtr<FJsonObject>& /*Json*/);
	FOnJsonMessage OnJsonMessage;

private:
	bool Tick(float DeltaTime);
	void OnClientConnected(INetworkingWebSocket* Socket);
	void OnDataReceived(void* Data, int32 DataSize);
	void OnSocketClosed();

	/** Log and dispatch a received message by type. */
	void DispatchMessage(const FString& Type, const TSharedPtr<FJsonObject>& Json);

	/** Check raw message bytes for high-priority type (avatar, self_id, etc). */
	static bool IsHighPriority(const TCHAR* Str, int32 Len);

	TUniquePtr<IWebSocketServer> Server;
	INetworkingWebSocket* ClientSocket = nullptr;
	FTSTicker::FDelegateHandle TickHandle;

	int32 Port = 0;

	// ── Priority message queue ────────────────────────────
	// Low-priority messages (object_render, etc.) are queued and drained
	// with a per-frame time budget so avatar updates aren't starved.
	struct FQueuedMessage
	{
		FString Type;
		TSharedPtr<FJsonObject> Json;
	};
	TArray<FQueuedMessage> LowPriorityQueue;
	static constexpr float MessageBudgetMs = 12.0f;

	// Stored state from Electron
	FString SelfAvatarId;
	float DrawDistance = 128.0f;
	double WorldOriginX = 0.0;
	double WorldOriginY = 0.0;

	// Stats
	int32 MessagesReceived = 0;
	int32 ObjectRenderCount = 0;
};
