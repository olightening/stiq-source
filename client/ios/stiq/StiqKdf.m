//  StiqKdf.m — RN bridge for PBKDF2 PIN derivation (src/lock/nativeKdf.ts).
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(StiqKdf, NSObject)
RCT_EXTERN_METHOD(pbkdf2:(NSString *)pin
                  saltHex:(NSString *)saltHex
                  iterations:(nonnull NSNumber *)iterations
                  dkLenBytes:(nonnull NSNumber *)dkLenBytes
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
