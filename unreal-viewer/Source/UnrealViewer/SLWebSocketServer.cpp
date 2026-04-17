#include "SLWebSocketServer.h"
#include "UnrealViewerModule.h"
#include "IWebSocketNetworkingModule.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Misc/CommandLine.h"

void USLWebSocketServer::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);

	// Parse -ws-port=NNNN from command line
	FString PortStr;
	if (!FParse::Value(FCommandLine::Get(), TEXT("ws-port="), PortStr))
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[SLWebSocket] No -ws-port= on command line, WebSocket server disabled"));
		return;
	}
	Port = FCString::Atoi(*PortStr);
	if (Port <= 0 || Port > 65535)
	{
		UE_LOG(LogSLViewer, Error, TEXT("[SLWebSocket] Invalid port: %s"), *PortStr);
		return;
	}

	// Load WebSocketNetworking module and create server
	IWebSocketNetworkingModule& WsModule = FModuleManager::LoadModuleChecked<IWebSocketNetworkingModule>(TEXT("WebSocketNetworking"));
	Server = WsModule.CreateServer();

	if (!Server)
	{
		UE_LOG(LogSLViewer, Error, TEXT("[SLWebSocket] Failed to create WebSocket server"));
		return;
	}

	FWebSocketClientConnectedCallBack ConnectedCallback;
	ConnectedCallback.BindUObject(this, &USLWebSocketServer::OnClientConnected);

	const bool bSuccess = Server->Init(static_cast<uint32>(Port), ConnectedCallback, TEXT("127.0.0.1"));
	if (!bSuccess)
	{
		UE_LOG(LogSLViewer, Error, TEXT("[SLWebSocket] Failed to start server on port %d"), Port);
		Server.Reset();
		return;
	}

	UE_LOG(LogSLViewer, Log, TEXT("[SLWebSocket] Server listening on ws://127.0.0.1:%d"), Port);

	// Register per-frame tick
	TickHandle = FTSTicker::GetCoreTicker().AddTicker(
		FTickerDelegate::CreateUObject(this, &USLWebSocketServer::Tick));
}

void USLWebSocketServer::Deinitialize()
{
	FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
	ClientSocket = nullptr;
	Server.Reset();

	UE_LOG(LogSLViewer, Log, TEXT("[SLWebSocket] Server shut down (received %d messages, %d object_render)"),
		MessagesReceived, ObjectRenderCount);

	Super::Deinitialize();
}

bool USLWebSocketServer::Tick(float DeltaTime)
{
	if (Server)
	{
		Server->Tick();
	}
	if (ClientSocket)
	{
		ClientSocket->Tick();
	}

	// Drain low-priority queue with time budget
	if (LowPriorityQueue.Num() > 0)
	{
		const double StartMs = FPlatformTime::Seconds() * 1000.0;
		while (LowPriorityQueue.Num() > 0)
		{
			const double ElapsedMs = FPlatformTime::Seconds() * 1000.0 - StartMs;
			if (ElapsedMs >= MessageBudgetMs)
			{
				break;
			}

			FQueuedMessage Msg = MoveTemp(LowPriorityQueue[0]);
			LowPriorityQueue.RemoveAt(0, EAllowShrinking::No);

			DispatchMessage(Msg.Type, Msg.Json);
			OnJsonMessage.Broadcast(Msg.Type, Msg.Json);
		}
	}

	return true;
}

void USLWebSocketServer::OnClientConnected(INetworkingWebSocket* Socket)
{
	if (ClientSocket)
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[SLWebSocket] New client connected but one already exists, replacing"));
	}

	ClientSocket = Socket;
	UE_LOG(LogSLViewer, Log, TEXT("[SLWebSocket] Electron connected from %s"), *Socket->RemoteEndPoint(true));

	FWebSocketPacketReceivedCallBack ReceiveCallback;
	ReceiveCallback.BindUObject(this, &USLWebSocketServer::OnDataReceived);
	Socket->SetReceiveCallBack(ReceiveCallback);

	FWebSocketInfoCallBack ClosedCallback;
	ClosedCallback.BindUObject(this, &USLWebSocketServer::OnSocketClosed);
	Socket->SetSocketClosedCallBack(ClosedCallback);

	// Tell Electron we're alive
	SendMessage(TEXT("{\"type\":\"ready\"}"));
}

void USLWebSocketServer::OnDataReceived(void* Data, int32 DataSize)
{
	if (DataSize <= 0) return;

	// Convert raw UTF-8 bytes to FString
	const FUTF8ToTCHAR Converter(static_cast<const ANSICHAR*>(Data), DataSize);
	const FString JsonStr(Converter.Length(), Converter.Get());

	MessagesReceived++;

	// Fast priority check on raw string before parsing (matching Godot's _is_high_priority)
	const bool bHighPriority = IsHighPriority(*JsonStr, FMath::Min(JsonStr.Len(), 50));

	// Parse JSON
	TSharedPtr<FJsonObject> JsonObj;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonStr);
	if (!FJsonSerializer::Deserialize(Reader, JsonObj) || !JsonObj.IsValid())
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[SLWebSocket] Invalid JSON (size=%d)"), DataSize);
		return;
	}

	FString Type;
	if (!JsonObj->TryGetStringField(TEXT("type"), Type))
	{
		return;
	}

	if (bHighPriority)
	{
		// Avatar updates, self_id, etc. — dispatch immediately
		DispatchMessage(Type, JsonObj);
		OnJsonMessage.Broadcast(Type, JsonObj);
	}
	else
	{
		// object_render, terrain, etc. — queue for time-budgeted processing
		LowPriorityQueue.Add({ MoveTemp(Type), MoveTemp(JsonObj) });
	}
}

bool USLWebSocketServer::IsHighPriority(const TCHAR* Str, int32 Len)
{
	// Peek at first ~50 chars for high-priority type prefixes.
	// Matches Godot's _is_high_priority: avatar_*, self_id, sitting_state,
	// electron_stats, pay_*, script_dialog, object_chat, teleport_*
	FString Prefix(Len, Str);
	return Prefix.Contains(TEXT("\"avatar_"))
		|| Prefix.Contains(TEXT("\"self_id\""))
		|| Prefix.Contains(TEXT("\"sitting_state\""))
		|| Prefix.Contains(TEXT("\"electron_stats\""))
		|| Prefix.Contains(TEXT("\"pay_"))
		|| Prefix.Contains(TEXT("\"script_dialog\""))
		|| Prefix.Contains(TEXT("\"object_chat\""))
		|| Prefix.Contains(TEXT("\"teleport_"))
		|| Prefix.Contains(TEXT("\"region_change\""));
}

void USLWebSocketServer::OnSocketClosed()
{
	UE_LOG(LogSLViewer, Log, TEXT("[SLWebSocket] Electron disconnected"));
	ClientSocket = nullptr;
}

void USLWebSocketServer::DispatchMessage(const FString& Type, const TSharedPtr<FJsonObject>& Json)
{
	if (Type == TEXT("self_id"))
	{
		Json->TryGetStringField(TEXT("id"), SelfAvatarId);
		UE_LOG(LogSLViewer, Log, TEXT("[SLWebSocket] self_id = %s"), *SelfAvatarId);
	}
	else if (Type == TEXT("settings"))
	{
		double Dist = 0;
		if (Json->TryGetNumberField(TEXT("draw_distance"), Dist))
		{
			DrawDistance = static_cast<float>(Dist);
		}
		UE_LOG(LogSLViewer, Log, TEXT("[SLWebSocket] settings: draw_distance=%.0f"), DrawDistance);
	}
	else if (Type == TEXT("world_origin"))
	{
		Json->TryGetNumberField(TEXT("originX"), WorldOriginX);
		Json->TryGetNumberField(TEXT("originY"), WorldOriginY);
		UE_LOG(LogSLViewer, Log, TEXT("[SLWebSocket] world_origin: (%.0f, %.0f)"), WorldOriginX, WorldOriginY);
	}
	else if (Type == TEXT("object_render"))
	{
		ObjectRenderCount++;
		if (ObjectRenderCount <= 5 || (ObjectRenderCount % 100 == 0))
		{
			FString Uuid;
			Json->TryGetStringField(TEXT("uuid"), Uuid);
			FString MeshPath;
			Json->TryGetStringField(TEXT("meshPath"), MeshPath);
			UE_LOG(LogSLViewer, Log, TEXT("[SLWebSocket] object_render #%d uuid=%s mesh=%s"),
				ObjectRenderCount, *Uuid.Left(8), *MeshPath.Right(30));
		}
	}
	else if (Type == TEXT("object_update_batch") || Type == TEXT("object_kill") || Type == TEXT("avatar_create")
		|| Type == TEXT("avatar_update_batch") || Type == TEXT("animations_batch") || Type == TEXT("region_change")
		|| Type == TEXT("terrain") || Type == TEXT("electron_stats"))
	{
		// Known message types — log periodically
		if (MessagesReceived <= 20 || (MessagesReceived % 500 == 0))
		{
			UE_LOG(LogSLViewer, Verbose, TEXT("[SLWebSocket] %s (msg #%d)"), *Type, MessagesReceived);
		}
	}
	else
	{
		// Unknown/unhandled type — log first occurrence
		UE_LOG(LogSLViewer, Log, TEXT("[SLWebSocket] Unhandled message type: %s"), *Type);
	}
}

void USLWebSocketServer::SendMessage(const FString& JsonString)
{
	if (!ClientSocket) return;

	const FTCHARToUTF8 Utf8(*JsonString);
	ClientSocket->Send(reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length(), false);
}

void USLWebSocketServer::SendJson(const TSharedRef<FJsonObject>& JsonObject)
{
	FString Output;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Output);
	FJsonSerializer::Serialize(JsonObject, Writer);
	SendMessage(Output);
}
