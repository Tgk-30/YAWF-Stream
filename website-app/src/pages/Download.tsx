import Hero from '@/pages/download/Hero';
import StreamPicker from '@/pages/download/StreamPicker';
import TrustPanel from '@/pages/download/TrustPanel';
import Verify from '@/pages/download/Verify';
import AndroidTVInstall from '@/pages/download/AndroidTVInstall';
import PwaSteps from '@/pages/download/PwaSteps';
import Updates from '@/pages/download/Updates';
import ClosingCta from '@/pages/download/ClosingCta';

/**
 * Download - `/download`
 * The signature "stream picker": platform rows styled as the app's own stream
 * list. Hero → Stream picker → Version & trust → PWA install steps → Updates → CTA.
 * No WebGL on this page - the row choreography is the showpiece.
 */
export default function Download() {
  return (
    <>
      <Hero />
      <StreamPicker />
      <TrustPanel />
      <Verify />
      <AndroidTVInstall />
      <PwaSteps />
      <Updates />
      <ClosingCta />
    </>
  );
}
