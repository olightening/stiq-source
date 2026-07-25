#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>

// NO BackgroundTasks / BGTaskScheduler. STIQ on iOS is foreground-only Tor (Path A): the app has no
// background-sync driver, so declaring UIBackgroundModes=[fetch,processing] for a handler that never
// touches Tor is an unused-capability (Guideline 2.5.4) rejection risk — and a half-built handler
// that "reads as complete" invites someone to finish it, violating the one-start invariant. Messages
// arrive on open; background receive is a deliberately-forfeited, separately-reviewed future feature.

// Keep the op-sqlite event caches out of iCloud backups (censorship-resistance threat model:
// the encrypted-at-rest SQLCipher DBs hold decrypted-in-app community content and must never
// land in an off-device backup — the StiqTor DataDirectory + keychain are already excluded /
// ThisDeviceOnly, this closes the DB leak).
//
// WHERE op-sqlite stores DBs on iOS (verified against @op-engineering/op-sqlite 11.4.9):
// with no `OPSQLite_AppGroup` Info.plist key (we set none) and no `location` passed to open()
// (sqliteFactory.ts passes only {name, encryptionKey}), the base path is NSLibraryDirectory —
// the app's Library/ ROOT. Files are named `stiq-cache*.db` (LEGACY_SQLITE_DB `stiq-cache.db`
// and per-(cid,slot) `stiq-cache-<cid>__<slot>.db`; workspaceKeys.ts), created directly in
// Library/ with SQLite's -wal/-shm/-journal sidecars.
//
// LIMITATION: the DBs live directly in Library/ root, NOT in a dedicated subdirectory, and
// op-sqlite gives the app no way to relocate them (we do not own sqliteFactory.ts, and it does
// not pass a `location`). We therefore CANNOT do a single directory-level exclusion — excluding
// all of Library/ would wrongly pull RN/system caches out of backup too. Instead we exclude each
// `stiq-cache*.db*` file that exists now. We sweep at two points: the launch sweep (below, run
// from didFinishLaunchingWithOptions before React Native init) covers DBs left over from prior
// sessions; the backgrounding sweep (registered on UIApplicationDidEnterBackgroundNotification)
// covers DBs created during the current session, since backgrounding is the earliest point at
// which the next iCloud backup can occur — so a DB opened mid-session (e.g. a fresh enrollment)
// is excluded before any backup can see it. The remaining gap — a DB created while the app is
// already backgrounded — cannot happen, since DB opens only occur on the foreground JS thread.
// (A future op-sqlite `location` set to a subdir would let this become a one-line directory
// exclusion that also covers files-created-later, removing the need for the second sweep.)
static void StiqExcludeDatabasesFromBackup(void)
{
  @try {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSURL *libraryURL = [[fm URLsForDirectory:NSLibraryDirectory inDomains:NSUserDomainMask] firstObject];
    if (libraryURL != nil) {
      NSArray<NSURL *> *entries =
          [fm contentsOfDirectoryAtURL:libraryURL
            includingPropertiesForKeys:nil
                               options:0
                                 error:nil];
      for (NSURL *entry in entries) {
        NSString *name = [entry lastPathComponent];
        // Matches stiq-cache.db, stiq-cache-<cid>__<slot>.db, and their -wal/-shm/-journal sidecars.
        if ([name hasPrefix:@"stiq-cache"] && [name containsString:@".db"]) {
          NSError *err = nil;
          if (![entry setResourceValue:@YES
                                forKey:NSURLIsExcludedFromBackupKey
                                 error:&err]) {
            NSLog(@"[stiq] backup-exclude: %@ failed: %@", name, err);
          }
        }
      }
    }
  } @catch (NSException *ex) {
    NSLog(@"[stiq] backup-exclude: exception %@", ex);
  }
}

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  // Runs BEFORE React Native init so the flag is set before op-sqlite's install() opens any file.
  StiqExcludeDatabasesFromBackup();

  // Re-sweep on backgrounding to catch DBs opened during this session (see LIMITATION above).
  [[NSNotificationCenter defaultCenter] addObserverForName:UIApplicationDidEnterBackgroundNotification
                                                     object:nil
                                                      queue:nil
                                                 usingBlock:^(NSNotification *note) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      StiqExcludeDatabasesFromBackup();
    });
  }];

  self.moduleName = @"stiq";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

// Deep links: organizer response QR is encoded as stiq://cred-resp?data=<b64>. The system
// camera opens it; RCTLinkingManager forwards it to JS (App.tsx Linking handler).
- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey, id> *)options
{
  return [RCTLinkingManager application:application openURL:url options:options];
}

- (BOOL)application:(UIApplication *)application
    continueUserActivity:(NSUserActivity *)userActivity
      restorationHandler:(void (^)(NSArray<id<UIUserActivityRestoring>> *_Nullable))restorationHandler
{
  return [RCTLinkingManager application:application
                  continueUserActivity:userActivity
                    restorationHandler:restorationHandler];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
