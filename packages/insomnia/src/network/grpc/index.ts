import * as grpc from '@grpc/grpc-js';
import { Call, ServiceError } from '@grpc/grpc-js';
import { ServiceClient } from '@grpc/grpc-js/build/src/make-client';

import { SegmentEvent, trackSegmentEvent } from '../../common/analytics';
import * as models from '../../models';
import type { GrpcRequest, GrpcRequestHeader } from '../../models/grpc-request';
import callCache from './call-cache';
import type { GrpcMethodDefinition } from './method';
import { getMethodType, GrpcMethodTypeEnum } from './method';
import parseGrpcUrl from './parse-grpc-url';
import type { GrpcIpcMessageParams, GrpcIpcRequestParams } from './prepare';
import * as protoLoader from './proto-loader';
import { ResponseCallbacks } from './response-callbacks';

const _createClient = (
  req: GrpcRequest,
  respond: ResponseCallbacks,
): ServiceClient | undefined => {
  const { url, enableTls } = parseGrpcUrl(req.url);

  if (!url) {
    respond.sendError(req._id, new Error('URL not specified'));
    return undefined;
  }

  const credentials = enableTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  console.log(`[gRPC] connecting to url=${url} ${enableTls ? 'with' : 'without'} TLS`);
  // @ts-expect-error -- TSCONVERSION second argument should be provided, send an empty string? Needs testing
  const Client = grpc.makeGenericClientConstructor({});
  return new Client(url, credentials);
};

const _makeUnaryRequest = (
  {
    requestId,
    method: { path, requestSerialize, responseDeserialize },
    client,
    respond,
    metadata,
  }: RequestData,
  bodyText: string,
): Call | undefined => {
  // Create callback
  const callback = _createUnaryCallback(requestId, respond);

  // Load initial message
  const messageBody = _parseMessage(bodyText, requestId, respond);

  if (!messageBody) {
    return;
  }

  const grpcMetadata = _parseMetadata(metadata, requestId, respond);

  if (!grpcMetadata) {
    return;
  }

  // eslint-disable-next-line consistent-return
  return client.makeUnaryRequest(
    path,
    requestSerialize,
    responseDeserialize,
    messageBody,
    grpcMetadata,
    callback,
  );
};

const _makeClientStreamRequest = ({
  requestId,
  method: { path, requestSerialize, responseDeserialize },
  client,
  respond,
  metadata,
}: RequestData): Call | undefined => {
  // Create callback
  const callback = _createUnaryCallback(requestId, respond);

  const grpcMetadata = _parseMetadata(metadata, requestId, respond);

  if (!grpcMetadata) {
    return;
  }

  // Make call
  return client.makeClientStreamRequest(path, requestSerialize, responseDeserialize, grpcMetadata, callback);
};

const _makeServerStreamRequest = (
  {
    requestId,
    method: { path, requestSerialize, responseDeserialize },
    client,
    respond,
    metadata,
  }: RequestData,
  bodyText: string,
): Call | undefined => {
  // Load initial message
  const messageBody = _parseMessage(bodyText, requestId, respond);

  if (!messageBody) {
    return;
  }

  const grpcMetadata = _parseMetadata(metadata, requestId, respond);

  if (!grpcMetadata) {
    return;
  }

  // Make call
  const call = client.makeServerStreamRequest(
    path,
    requestSerialize,
    responseDeserialize,
    messageBody,
    grpcMetadata,
  );

  _setupServerStreamListeners(call, requestId, respond);

  // eslint-disable-next-line consistent-return
  return call;
};

const _makeBidiStreamRequest = ({
  requestId,
  method: { path, requestSerialize, responseDeserialize },
  client,
  respond,
  metadata,
}: RequestData): Call | undefined => {
  const grpcMetadata = _parseMetadata(metadata, requestId, respond);

  if (!grpcMetadata) {
    return;
  }

  // Make call
  const call = client.makeBidiStreamRequest(path, requestSerialize, responseDeserialize, grpcMetadata);

  _setupServerStreamListeners(call, requestId, respond);

  return call;
};

interface RequestData {
  requestId: string;
  respond: ResponseCallbacks;
  client: ServiceClient;
  method: GrpcMethodDefinition;
  metadata: GrpcRequestHeader[];
}

export const start = async (
  { request }: GrpcIpcRequestParams,
  respond: ResponseCallbacks,
) => {
  const requestId = request._id;
  const metadata = request.metadata;
  const method = await protoLoader.getSelectedMethod(request);

  if (!method) {
    respond.sendError(
      requestId,
      new Error(`The gRPC method ${request.protoMethodName} could not be found`),
    );
    return;
  }

  const methodType = getMethodType(method);

  // Create client
  const client = _createClient(request, respond);

  if (!client) {
    return;
  }

  const requestParams: RequestData = {
    requestId,
    client,
    method,
    respond,
    metadata,
  };
  let call;

  switch (methodType) {
    case GrpcMethodTypeEnum.unary:
      call = _makeUnaryRequest(requestParams, request.body.text || '');
      break;

    case GrpcMethodTypeEnum.server:
      call = _makeServerStreamRequest(requestParams, request.body.text || '');
      break;

    case GrpcMethodTypeEnum.client:
      call = _makeClientStreamRequest(requestParams);
      break;

    case GrpcMethodTypeEnum.bidi:
      call = _makeBidiStreamRequest(requestParams);
      break;

    default:
      return;
  }

  if (!call) {
    return;
  }

  // Update request stats
  models.stats.incrementExecutedRequests();
  trackSegmentEvent(SegmentEvent.requestExecute);

  _setupStatusListener(call, requestId, respond);

  respond.sendStart(requestId);
  // Save call
  callCache.set(requestId, call);
};

export const sendMessage = (
  { body, requestId }: GrpcIpcMessageParams,
  respond: ResponseCallbacks,
) => {
  const messageBody = _parseMessage(body.text || '', requestId, respond);

  if (!messageBody) {
    return;
  }

  // HACK BUT DO NOT REMOVE
  // this must happen in the next tick otherwise the stream does not flush correctly
  // Try removing it and using a bidi RPC and notice messages don't send consistently
  process.nextTick(() => {
    // @ts-expect-error -- TSCONVERSION only write if the call is ClientWritableStream | ClientDuplexStream
    callCache.get(requestId)?.write(messageBody, _streamWriteCallback);
  });
};

// @ts-expect-error -- TSCONVERSION only end if the call is ClientWritableStream | ClientDuplexStream
export const commit = (requestId: string) => callCache.get(requestId)?.end();
export const cancel = (requestId: string) => callCache.get(requestId)?.cancel();
export const cancelMultiple = (requestIds: string[]) => requestIds.forEach(cancel);

const _setupStatusListener = (call: Call, requestId: string, respond: ResponseCallbacks) => {
  call.on('status', s => respond.sendStatus(requestId, s));
};

const _setupServerStreamListeners = (call: Call, requestId: string, respond: ResponseCallbacks) => {
  call.on('data', data => respond.sendData(requestId, data));
  call.on('error', (error: ServiceError) => {
    if (error && error.code !== grpc.status.CANCELLED) {
      respond.sendError(requestId, error);

      // Taken through inspiration from other implementation, needs validation
      if (error.code === grpc.status.UNKNOWN || error.code === grpc.status.UNAVAILABLE) {
        respond.sendEnd(requestId);
        callCache.clear(requestId);
      }
    }
  });
  call.on('end', () => {
    respond.sendEnd(requestId);
    callCache.clear(requestId);
  });
};

// This function returns a function
const _createUnaryCallback = (requestId: string, respond: ResponseCallbacks) => (
  err: ServiceError,
  value: Record<string, any>,
) => {
  if (err) {
    // Don't do anything if cancelled
    // TODO: test with other errors
    if (err.code !== grpc.status.CANCELLED) {
      respond.sendError(requestId, err);
    }
  } else {
    respond.sendData(requestId, value);
  }

  respond.sendEnd(requestId);
  callCache.clear(requestId);
};

type WriteCallback = (error: Error | null | undefined) => void;

const _streamWriteCallback: WriteCallback = err => {
  if (err) {
    console.error('[gRPC] Error when writing to stream', err);
  }
};

const _parseMessage = (
  bodyText: string,
  requestId: string,
  respond: ResponseCallbacks,
): Record<string, any> | undefined => {
  try {
    return JSON.parse(bodyText);
  } catch (error) {
    // TODO: How do we want to handle this case, where the message cannot be parsed?
    //  Currently an error will be shown, but the stream will not be cancelled.
    respond.sendError(requestId, error);
    return undefined;
  }
};

const _parseMetadata = (
  metadata: GrpcRequestHeader[],
  requestId: string,
  respond: ResponseCallbacks,
): grpc.Metadata | undefined => {
  const grpcMetadata = new grpc.Metadata();
  for (const entry of metadata) {
    if (!entry.disabled) {
      try {
        grpcMetadata.add(entry.name, entry.value);
      } catch (err) {
        respond.sendError(requestId, err);
        return undefined;
      }
    }
  }
  return grpcMetadata;
};
