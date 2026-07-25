//
//  StiqPow.m — Objective-C bridge exposing the Swift StiqPow miner to React Native.
//
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(StiqPow, NSObject)

RCT_EXTERN_METHOD(minePow:(NSString *)serialized
                  nonceOffset:(nonnull NSNumber *)nonceOffset
                  nonceWidth:(nonnull NSNumber *)nonceWidth
                  difficulty:(nonnull NSNumber *)difficulty
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
