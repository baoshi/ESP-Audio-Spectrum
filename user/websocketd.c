#include "ets_sys.h"
#include "osapi.h"
#include "os_type.h"
#include "sha1.h"
#include "base64.h"

#include "websocketd.h"

//server socket
static struct espconn wsConn;
static esp_tcp wsTcp;
static WSOnConnection wsOnConnectionCallback;
static WSConnection wsConnections[WS_MAXCONN];

static int ICACHE_FLASH_ATTR createWsAcceptKey(const char *key, char *buffer, int bufferSize) {
	sha1nfo s;

	char concatenatedBuffer[512];
	concatenatedBuffer[0] = '\0';
	//concatenate the key and the GUID
	os_strcat(concatenatedBuffer, key);
	os_strcat(concatenatedBuffer, WS_GUID);

	//build the sha1 hash
	sha1_init(&s);
	sha1_write(&s, concatenatedBuffer, strlen(concatenatedBuffer));
	uint8_t *hash = sha1_result(&s);

	return base64_encode(20, hash, bufferSize, buffer);
}

static void ICACHE_FLASH_ATTR parseWsFrame(char *data, WSFrame *frame) {
	frame->flags = (*data) & FLAGS_MASK;
	frame->opcode = (*data) & OPCODE_MASK;
	//next byte
	data += 1;
	frame->isMasked = (*data) & IS_MASKED;
	frame->payloadLength = (*data) & PAYLOAD_MASK;

	//next byte
	data += 1;

	if (frame->payloadLength == 126) {
		frame->payloadLength = *(data) * 256 + *(data + 1);
		data += 2;
	} else if (frame->payloadLength == 127) {
	    frame->payloadLength = *(data) * 16777216 + *(data + 1) * 65536 + *(data + 2) * 256 + *(data + 3);
		data += 4;
	}

	if (frame->isMasked) {
		os_memcpy(&frame->maskingKey, data, sizeof(uint32_t));
		data += sizeof(uint32_t);
	}

	frame->payloadData = data;
}

static void ICACHE_FLASH_ATTR unmaskWsPayload(char *maskedPayload, uint64_t payloadLength, uint32_t maskingKey) {
	//the algorith described in IEEE RFC 6455 Section 5.3
	//TODO: this should decode the payload 4-byte wise and do the remainder afterwards
    int i;
	for (i = 0; i < payloadLength; i++) {
		int j = i % 4;
		maskedPayload[i] = maskedPayload[i] ^ ((uint8_t *)&maskingKey)[j];
	}
}

void ICACHE_FLASH_ATTR broadcastWsMessage(const char *payload, uint64_t payloadLength, uint8_t options) {
    int slotId;
	for(slotId=0; slotId < WS_MAXCONN; slotId++){
		WSConnection connection = wsConnections[slotId];
		if(connection.connection != NULL && connection.status == STATUS_OPEN){
			sendWsMessage(&connection, payload, payloadLength, options);
		}
	}
}

void ICACHE_FLASH_ATTR sendWsMessage(WSConnection* connection, const char *payload, uint64_t payloadLength, uint8_t options) {
	uint8_t payloadLengthField[9];
	uint8_t payloadLengthFieldLength = 0;


	if (payloadLength > ((1 << 16) - 1)) {
		payloadLengthField[0] = 127;
		os_memcpy(payloadLengthField + 1, &payloadLength, sizeof(uint64_t));
		payloadLengthFieldLength = sizeof(uint64_t) + 1;
	} else if (payloadLength > ((1 << 8) - 1)) {
		payloadLengthField[0] = 126;
		os_memcpy(payloadLengthField + 1, &payloadLength, sizeof(uint16_t));
		payloadLengthFieldLength = sizeof(uint16_t) + 1;
	} else {
		payloadLengthField[0] = payloadLength;
		payloadLengthFieldLength = 1;
	}

	uint64_t maximumPossibleMessageSize = 14 + payloadLength; //14 bytes is the biggest frame header size
	char message[maximumPossibleMessageSize];
	message[0] = options;

	os_memcpy(message + 1, &payloadLengthField, payloadLengthFieldLength);
	os_memcpy(message + 1 + payloadLengthFieldLength, payload, strlen(payload));

	espconn_sent(connection->connection, (uint8_t *)&message, payloadLength + 1 + payloadLengthFieldLength);
}

void ICACHE_FLASH_ATTR closeWsConnection(WSConnection* connection) {
	char closeMessage[CLOSE_MESSAGE_LENGTH] = CLOSE_MESSAGE;
	espconn_sent(connection->connection, (uint8_t *)closeMessage, sizeof(closeMessage));
	connection->status = STATUS_CLOSED;
	return;
}

static WSConnection *ICACHE_FLASH_ATTR getWsConnection(struct espconn *connection) {
    int slotId;
	for (slotId = 0; slotId < WS_MAXCONN; slotId++) {
		if (wsConnections[slotId].connection == connection) {
			return wsConnections + slotId;
		}
	}
	return NULL;
}

static void ICACHE_FLASH_ATTR wsSentCb(void *esp_connection) {
	WSConnection *wsConnection = getWsConnection(esp_connection);

	if (wsConnection == NULL) {
		//huh?
		return;
	}

	if(wsConnection->status == STATUS_CLOSED){
		//Close message sent, now close the socket
		espconn_disconnect(wsConnection->connection);
		//free the slot
		wsConnection->connection = NULL;
	}
}

static void ICACHE_FLASH_ATTR wsRecvCb(void *esp_connection, char *data, unsigned short len) {
	WSConnection *wsConnection = getWsConnection(esp_connection);
	/*if (wsConnection == NULL) {
		//huh?
		return;
	}*/

	//get the first occurrence of the key identifier
	char *key = (char *)os_strstr(data, WS_KEY_IDENTIFIER);

	if (key != NULL) {
		// ------------------------ Handle the Handshake ------------------------

		//Skip the identifier (that contains the space already)
		key += os_strlen(WS_KEY_IDENTIFIER);

		//the key ends at the newline
		char *endSequence = (char *)os_strstr(key, HTML_HEADER_LINEEND);
		if (endSequence != NULL) {
			int keyLastChar = endSequence - key;
			//we can throw away all the other data, only the key is interesting
			key[keyLastChar] = '\0';

			char acceptKey[100];
			createWsAcceptKey(key, acceptKey, 100);

			//now construct our message and send it back to the client
			char responseMessage[strlen(WS_RESPONSE) + 100];
			os_sprintf(responseMessage, WS_RESPONSE, acceptKey);

			//send the response
			espconn_sent(esp_connection, (uint8_t *)responseMessage, strlen(responseMessage));
			wsConnection->status = STATUS_OPEN;
			//call the connection callback
			if (wsOnConnectionCallback != NULL) {
				wsOnConnectionCallback(wsConnection);
			}
		}
	} else {
		// ------------------------ Handle a Frame ------------------------
		WSFrame frame;
		parseWsFrame(data, &frame);

		if (frame.isMasked) {
			unmaskWsPayload(frame.payloadData, frame.payloadLength, frame.maskingKey);
		} else {
			//we are the server, and need to shut down the connection
			//if we receive an unmasked packet
			closeWsConnection(wsConnection);
			return;
		}

		if (frame.opcode == OPCODE_PING) {
		    os_printf("\n\n\nPING\n");
			sendWsMessage(wsConnection, frame.payloadData, frame.payloadLength, FLAG_FIN | OPCODE_PONG);
			return;
		}

		if(frame.opcode == OPCODE_CLOSE){
		    os_printf("\n\n\nCLOSE\n");
			//gracefully shut down the connection
			closeWsConnection(wsConnection);
			return;
		}

		if(wsConnection->onMessage != NULL){
			wsConnection->onMessage(wsConnection, &frame);
		}
	}
}

static void ICACHE_FLASH_ATTR wsConnectCb(void *connection) {

	//find an empty slot
	uint8_t slotId = 0;
	while (wsConnections[slotId].connection != NULL && slotId < WS_MAXCONN) {
		slotId++;
	}

	if (slotId == WS_MAXCONN) {
		//no more free slots, close the connection
		espconn_disconnect(connection);
		return;
	}

	WSConnection wsConnection;
	wsConnection.status = STATUS_UNINITIALISED;
	wsConnection.connection = connection;
	wsConnections[slotId] = wsConnection;

	espconn_regist_recvcb(connection, wsRecvCb);
	espconn_regist_sentcb(connection, wsSentCb);
}

void ICACHE_FLASH_ATTR websocketdInit(int port, WSOnConnection onConnection) {

	wsOnConnectionCallback = onConnection;

	wsConn.type = ESPCONN_TCP;
	wsConn.state = ESPCONN_NONE;

	wsTcp.local_port = port;
	wsConn.proto.tcp = &wsTcp;

	espconn_regist_connectcb(&wsConn, wsConnectCb);
	espconn_accept(&wsConn);
	espconn_regist_time(&wsConn, CONN_TIMEOUT, 0);
}
