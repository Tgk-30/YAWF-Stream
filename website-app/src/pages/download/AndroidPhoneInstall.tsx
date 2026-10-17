import { Download, ShieldCheck, Smartphone } from 'lucide-react';
import { PrimaryButton } from '@/components/Buttons';
import GlassCard from '@/components/GlassCard';
import SectionHeading from '@/components/SectionHeading';
import { ANDROID_PHONE_RELEASE, DOWNLOAD_LINKS } from '@/lib/site';

/** Standalone Android phone/tablet install, kept separate from the server-hosted PWA. */
export default function AndroidPhoneInstall() {
  return (
    <section className="relative py-[clamp(72px,10vw,128px)]">
      <div className="mx-auto max-w-content px-6 md:px-10">
        <SectionHeading
          eyebrow="// ANDROID PHONE AND TABLET"
          title="Install the native Android app."
          lede="The signed APK is a standalone Android app. You do not need to run your own personal server to install it. Streaming needs an internet connection and your configured providers. Server Mode is optional."
        >
          <div className="mt-7 flex flex-wrap items-center gap-4">
            <PrimaryButton href={DOWNLOAD_LINKS.androidPhone}>Download Android APK</PrimaryButton>
            <span className="font-mono text-xs tracking-[0.04em] text-ink-3">{ANDROID_PHONE_RELEASE.tag}</span>
          </div>
        </SectionHeading>

        <div className="mt-10 grid gap-5 md:grid-cols-3">
          <GlassCard className="h-full">
            <Download className="h-5 w-5 text-brand" />
            <h3 className="display-s mt-4 font-display">One direct APK</h3>
            <p className="mt-2 text-[0.95rem] leading-[1.7] text-ink-2">Download, allow this source when Android asks, then install the native app on your phone or tablet.</p>
          </GlassCard>
          <GlassCard className="h-full">
            <Smartphone className="h-5 w-5 text-brand" />
            <h3 className="display-s mt-4 font-display">Not the PWA</h3>
            <p className="mt-2 text-[0.95rem] leading-[1.7] text-ink-2">The APK is the native Android channel. The server-hosted PWA below is optional and is the path for iPhone and iPad.</p>
          </GlassCard>
          <GlassCard className="h-full">
            <ShieldCheck className="h-5 w-5 text-brand" />
            <h3 className="display-s mt-4 font-display">Updates stay explicit</h3>
            <p className="mt-2 text-[0.95rem] leading-[1.7] text-ink-2">Check the published {ANDROID_PHONE_RELEASE.tag} release and Android version compatibility before updating. The download does not silently install updates.</p>
          </GlassCard>
        </div>

        <div className="mt-6 rounded-row border border-line bg-[var(--surface-glass)] p-4 font-mono text-xs leading-relaxed text-ink-2">
          <p className="text-ink-1">Android channel: {ANDROID_PHONE_RELEASE.tag}</p>
          <p className="mt-2">Server Mode remains optional for this native install. iPhone and iPad use the PWA and require a running server.</p>
        </div>
      </div>
    </section>
  );
}
