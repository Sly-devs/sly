'use client';

import { motion } from 'framer-motion';

const orbs = [
  {
    // Orb 1: blue-600, top-right area
    className: 'bg-blue-600',
    style: { width: 300, height: 300, top: '8%', right: '10%', opacity: 0.1 },
    animate: {
      x: [0, 20, -10, 0],
      y: [0, -15, 10, 0],
      opacity: [0.1, 0.12, 0.08, 0.1],
    },
    duration: 10,
  },
  {
    // Orb 2: purple-600, bottom-left area
    className: 'bg-purple-600',
    style: { width: 250, height: 250, bottom: '12%', left: '8%', opacity: 0.08 },
    animate: {
      x: [0, -15, 20, 0],
      y: [0, 20, -10, 0],
      opacity: [0.08, 0.1, 0.06, 0.08],
    },
    duration: 12,
  },
  {
    // Orb 3: emerald-600, center area
    className: 'bg-emerald-600',
    style: { width: 200, height: 200, top: '45%', left: '45%', opacity: 0.05 },
    animate: {
      x: [0, 10, -20, 0],
      y: [0, -20, 15, 0],
      opacity: [0.05, 0.07, 0.03, 0.05],
    },
    duration: 8,
  },
];

export function SetupBackground() {
  return (
    <div className="fixed inset-0 z-0 overflow-hidden">
      {/* Layer 1: Deep navy base matching --background */}
      <div className="absolute inset-0 bg-background" />

      {/* Layer 2: Gradient orbs */}
      {orbs.map((orb, i) => (
        <motion.div
          key={i}
          className={`absolute rounded-full ${orb.className}`}
          style={{
            ...orb.style,
            filter: 'blur(100px)',
          }}
          animate={orb.animate}
          transition={{
            duration: orb.duration,
            repeat: Infinity,
            repeatType: 'loop',
            ease: 'easeInOut',
          }}
        />
      ))}
    </div>
  );
}
