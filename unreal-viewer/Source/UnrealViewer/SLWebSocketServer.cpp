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
	const FString JsonStr = FString(DataSize, UTF8_TO_TCHAR(static_cast<const ANSICHAR*>(Data)));

	// Parse JSON
	TSharedPtr<FJsonObject> JsonObj;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonStr);
	if (!FJsonSerializer::Deserialize(Reader, JsonObj) || !JsonObj.IsValid())
	{
		UE_LOG(LogSLViewer, Warning, TEXT("[SLWebSocket] Invalid JSON (size=%d)"), DataSize);
		return;
	}

	MessagesReceived++;

	FString Type;
	if (JsonObj->TryGetStringField(TEXT("type"), Type))
	{
		DispatchMessage(Type, JsonObj);
		OnJsonMessage.Broadcast(Type, JsonObj);
	}
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
