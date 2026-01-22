'use client';

import Link from 'next/link';
import Image from 'next/image';

export default function HomePage() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center">
      {/* Logo */}
      <div className="mb-8">
        <Image
          src="/logo.jpg"
          alt="The Contrarian Compass"
          width={250}
          height={250}
          className="rounded-full shadow-lg"
          priority
        />
      </div>

      {/* Tagline */}
      <p className="text-xl text-gray-600 mb-12 text-center max-w-xl">
        Navigate the markets with data-driven contrarian strategies
      </p>

      {/* Navigation Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full">
        <Link href="/dogs-of-the-dow" className="group">
          <div className="relative h-64 rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-shadow border-2 border-transparent hover:border-amber-700">
            <Image
              src="/dogs_of_the_dow.jpg"
              alt="Dogs of the Dow"
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
              <h2 className="text-xl font-bold mb-1">Dogs of the Dow</h2>
              <p className="text-sm text-gray-200">
                Tangency portfolio on high-yield Dow stocks
              </p>
            </div>
          </div>
        </Link>

        <Link href="/contrarian-plays" className="group">
          <div className="relative h-64 rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-shadow border-2 border-transparent hover:border-amber-700">
            <Image
              src="/contrarian_plays.jpg"
              alt="Contrarian Plays"
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
              <h2 className="text-xl font-bold mb-1">Contrarian Plays</h2>
              <p className="text-sm text-gray-200">
                Opportunities against market sentiment
              </p>
            </div>
          </div>
        </Link>

        <Link href="/genesis" className="group">
          <div className="relative h-64 rounded-lg overflow-hidden shadow-md hover:shadow-xl transition-shadow border-2 border-transparent hover:border-amber-700">
            <Image
              src="/genesis.jpg"
              alt="Genesis"
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-4 text-white">
              <h2 className="text-xl font-bold mb-1">Genesis</h2>
              <p className="text-sm text-gray-200">
                Early-stage opportunities and emerging trends
              </p>
            </div>
          </div>
        </Link>
      </div>
    </div>
  );
}
