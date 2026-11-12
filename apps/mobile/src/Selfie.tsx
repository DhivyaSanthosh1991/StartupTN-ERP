import React, { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import { Button, Notice, Sheet, s } from './ui';

/** Takes the selfie and shrinks it to a small JPEG (the server accepts up to about 300 KB). */
export function SelfieSheet({ open, onDone, onCancel }: { open: boolean; onDone: (base64: string) => void; onCancel: () => void }) {
  const [perm, ask] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function snap() {
    setBusy(true);
    setError('');
    try {
      const pic = await cam.current?.takePictureAsync({ quality: 0.5, skipProcessing: true });
      if (!pic) throw new Error('The photo could not be taken. Try again.');
      const small = await ImageManipulator.manipulateAsync(pic.uri, [{ resize: { width: 480 } }], { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true });
      if (!small.base64) throw new Error('The photo could not be prepared. Try again.');
      onDone(small.base64);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The photo could not be taken.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} title="Take your selfie">
      {!perm?.granted ? (
        <View>
          <Text style={s.body}>The camera is needed for the check-in selfie.</Text>
          <Button title="Allow camera" onPress={() => void ask()} />
        </View>
      ) : (
        <View>
          <View style={{ height: 320, borderRadius: 14, overflow: 'hidden', marginBottom: 10 }}>
            <CameraView ref={cam} style={{ flex: 1 }} facing="front" />
          </View>
          {error ? <Notice tone="error" text={error} /> : null}
          <Button title="Take photo and continue" onPress={snap} busy={busy} />
        </View>
      )}
      <Button title="Cancel" kind="quiet" onPress={onCancel} />
    </Sheet>
  );
}
