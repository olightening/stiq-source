//  StiqHttp.m — RN bridge for the Tor-routed HTTP fetch (src/media/torHttp.ts).
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(StiqHttp, NSObject)
RCT_EXTERN_METHOD(request:(NSDictionary *)opts
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
