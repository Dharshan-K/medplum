import { ContentType, getReferenceString, normalizeErrorString } from '@medplum/core';
import { Agent, Bot, ProjectMembership } from '@medplum/fhirtypes';
import { AsyncLocalStorage } from 'async_hooks';
import bytes from 'bytes';
import { randomUUID } from 'crypto';
import http, { IncomingMessage } from 'http';
import { Redis } from 'ioredis';
import ws from 'ws';
import { getConfig } from './config';
import { RequestContext, requestContextStore } from './context';
import { getRepoForLogin } from './fhir/accesspolicy';
import { executeBot } from './fhir/operations/execute';
import { handleFhircastConnection } from './fhircast/websocket';
import { globalLogger } from './logger';
import { getLoginForAccessToken } from './oauth/utils';
import { getRedis } from './redis';

const handlerMap = new Map<string, (socket: ws.WebSocket, request: IncomingMessage) => Promise<void>>();
handlerMap.set('echo', handleEchoConnection);
handlerMap.set('agent', handleAgentConnection);
handlerMap.set('fhircast', handleFhircastConnection);

let wsServer: ws.Server | undefined = undefined;

/**
 * Initializes a websocket listener on the given HTTP server.
 * @param server The HTTP server.
 */
export function initWebSockets(server: http.Server): void {
  wsServer = new ws.Server({
    noServer: true,
    maxPayload: bytes(getConfig().maxJsonSize) as number,
  });

  wsServer.on('connection', async (socket, request) => {
    // Set binary type to 'nodebuffer' so that data is returned as Buffer objects
    // See: https://github.com/websockets/ws/blob/master/doc/ws.md#websocketbinarytype
    socket.binaryType = 'nodebuffer';

    const handler = handlerMap.get(getWebSocketPath(request.url as string));
    if (handler) {
      await requestContextStore.run(RequestContext.empty(), () => handler(socket, request));
    } else {
      socket.close();
    }
  });

  server.on('upgrade', (request, socket, head) => {
    if (handlerMap.has(getWebSocketPath(request.url as string))) {
      wsServer?.handleUpgrade(request, socket, head, (socket) => {
        wsServer?.emit('connection', socket, request);
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });
}

function getWebSocketPath(path: string): string {
  return path.split('/').filter(Boolean)[1];
}

/**
 * Handles a new WebSocket connection to the echo service.
 * The echo service simply echoes back whatever it receives.
 * @param socket The WebSocket connection.
 */
async function handleEchoConnection(socket: ws.WebSocket): Promise<void> {
  // Create a redis client for this connection.
  // According to Redis documentation: http://redis.io/commands/subscribe
  // Once the client enters the subscribed state it is not supposed to issue any other commands,
  // except for additional SUBSCRIBE, PSUBSCRIBE, UNSUBSCRIBE and PUNSUBSCRIBE commands.
  const redisSubscriber = getRedis().duplicate();
  const channel = randomUUID();

  await redisSubscriber.subscribe(channel);

  redisSubscriber.on('message', (channel: string, message: string) => {
    globalLogger.debug('[WS] redis message', { channel, message });
    socket.send(message, { binary: false });
  });

  socket.on('message', async (data: ws.RawData) => {
    await getRedis().publish(channel, data as Buffer);
  });

  socket.on('close', async () => {
    redisSubscriber.disconnect();
  });
}

/**
 * Handles a new WebSocket connection to the agent service.
 * The agent service executes a bot and returns the result.
 * @param socket The WebSocket connection.
 * @param request The HTTP request.
 */
async function handleAgentConnection(socket: ws.WebSocket, request: IncomingMessage): Promise<void> {
  const remoteAddress = request.socket.remoteAddress;
  let agent: Agent | undefined = undefined;
  let bot: Bot | undefined = undefined;
  let runAs: ProjectMembership | undefined = undefined;

  // Create a redis client for this connection.
  // According to Redis documentation: http://redis.io/commands/subscribe
  // Once the client enters the subscribed state it is not supposed to issue any other commands,
  // except for additional SUBSCRIBE, PSUBSCRIBE, UNSUBSCRIBE and PUNSUBSCRIBE commands.
  let redisSubscriber: Redis | undefined = undefined;

  socket.on(
    'message',
    AsyncLocalStorage.bind(async (data: ws.RawData) => {
      try {
        const command = JSON.parse((data as Buffer).toString('utf8'));
        switch (command.type) {
          case 'connect':
            await handleConnect(command);
            break;

          case 'transmit':
            await handleTransmit(command);
            break;
        }
      } catch (err) {
        socket.send(JSON.stringify({ type: 'error', message: normalizeErrorString(err) }));
      }
    })
  );

  socket.on('close', () => {
    redisSubscriber?.disconnect();
  });

  /**
   * Handles a connect command.
   * This command is sent by the agent to connect to the server.
   * The command includes the access token and bot ID.
   * @param command The connect command.
   */
  async function handleConnect(command: any): Promise<void> {
    const { accessToken, agentId, botId } = command;
    const { login, project, membership } = await getLoginForAccessToken(accessToken);
    const repo = await getRepoForLogin(login, membership, project.strictMode, true, project.checkReferencesOnWrite);
    agent = await repo.readResource<Agent>('Agent', agentId);
    bot = await repo.readResource<Bot>('Bot', botId);
    runAs = membership;

    // Connect to Redis
    redisSubscriber = getRedis().duplicate();
    await redisSubscriber.subscribe(getReferenceString(agent));
    redisSubscriber.on('message', (_channel: string, message: string) => {
      socket.send(JSON.stringify({ type: 'transmit', message }), { binary: false });
    });

    // Send connected message
    socket.send(JSON.stringify({ type: 'connected' }));
  }

  /**
   * Handles a transit command.
   * This command is sent by the agent to transmit a message.
   * @param command The transmit command.
   */
  async function handleTransmit(command: any): Promise<void> {
    if (!bot || !runAs) {
      socket.send(JSON.stringify({ type: 'error', message: 'Not connected' }));
      return;
    }
    const result = await executeBot({
      agent,
      bot,
      runAs,
      contentType: ContentType.HL7_V2,
      input: command.message,
      remoteAddress,
      forwardedFor: command.forwardedFor,
    });
    socket.send(JSON.stringify({ type: 'transmit', message: result.returnValue }), { binary: false });
  }
}

export function closeWebSockets(): void {
  if (wsServer) {
    wsServer.close();
    wsServer = undefined;
  }
}
