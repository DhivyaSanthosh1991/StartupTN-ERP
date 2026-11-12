# StartupTN Staff app (Android first, iPhone later)

Expo (React Native). It talks to the same server as the website.

## Build the Android file (APK) to install on phones

Run these in PowerShell, in this folder (`apps\mobile`). You need Node.js and a free account at expo.dev.

```powershell
npm install
npm install -g eas-cli
eas login
eas init
eas build --platform android --profile preview
```

- `eas init` links the app to your Expo account (answer Yes to create the project).
- The build runs on Expo's servers (10 to 20 minutes on the free plan, sometimes a queue). When it finishes it prints a download link and a QR code for the `.apk`. Open the link on an Android phone and install it (allow "install unknown apps" if asked).
- The server address is in `app.json` under `extra.apiUrl`. Change it when the server moves to AWS, then build again.

## Try it quickly without building

Install **Expo Go** from the Play Store, run `npx expo start` here, and scan the QR code. Background location does not work in Expo Go, so use the APK for the tracking test.

## Server switches

- `REQUIRE_MOBILE_APP=true` on the API service makes check-in, breaks, presence checks and tracking work only from the app. Leave it off while testing; turn it on when staff move to the app.
- `MOBILE_SESSION_DAYS` (default 60): how long the phone stays signed in.

## Known limits of this first version

- Sign-in uses the same email login as the demo site. Google sign-in comes with the Google setup.
- Presence checks appear when the app is open or when a push notification arrives. Server-sent push for closed apps is the next step (phones are already registered for it).
- Leave, on-duty and approvals are still on the website; the app has check-in/out, breaks, presence checks and tracking.
