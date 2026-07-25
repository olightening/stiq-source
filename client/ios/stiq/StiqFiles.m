//
//  StiqFiles.m — Objective-C bridge exposing the Swift StiqFiles module to React Native.
//  Mirrors the sibling shims (StiqPow.m etc.) — old-architecture RCT_EXTERN_MODULE.
//
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(StiqFiles, NSObject)

RCT_EXTERN_METHOD(saveTextFile:(NSString *)name
                  mime:(NSString *)mime
                  content:(NSString *)content
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
