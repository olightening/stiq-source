//
//  StiqSocket.m — Objective-C bridge exposing the Swift StiqSocket to React Native.
//
//  The signature MUST match the JS contract in client/src/nostr/torSocket.ts:
//      connect(socketId, url, socksHost, socksPort, socksUser, socksPass)
//      send(socketId, message)
//      close(socketId)
//  RN binds these positionally, so arity + order are load-bearing (see the plan's BLOCKER).
//
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(StiqSocket, RCTEventEmitter)

RCT_EXTERN_METHOD(connect:(NSString *)socketId
                  url:(NSString *)url
                  socksHost:(NSString *)socksHost
                  socksPort:(nonnull NSNumber *)socksPort
                  socksUser:(NSString *)socksUser
                  socksPass:(NSString *)socksPass
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(send:(NSString *)socketId
                  message:(NSString *)message
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(close:(NSString *)socketId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
