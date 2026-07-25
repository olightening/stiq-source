//  StiqImage.m — RN bridge for the image sanitizer / pixel source (src/media/mediaService.ts).
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(StiqImage, NSObject)
RCT_EXTERN_METHOD(process:(NSString *)base64
                  maxDim:(nonnull NSNumber *)maxDim
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(pixels:(NSString *)base64
                  maxSide:(nonnull NSNumber *)maxSide
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(savePng:(NSString *)pngBase64
                  name:(NSString *)name
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
