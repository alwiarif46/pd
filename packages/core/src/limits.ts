export const PLAN_LIMITS = {
  free: {
    rfpCreditsFirstMonth: 2,
    rfpCreditsSubsequent: 1,
    maxUsers: 2,
    mbPerBid: 50,
    storageMb: 200,
  },
  starter: {
    rfpCreditsPerMonth: 10,
    maxUsers: 5,
    mbPerBid: 300,
    storageMb: 9000,
  },
  growth: {
    rfpCreditsPerMonth: 20,
    maxUsers: 5,
    mbPerBid: 300,
    storageMb: 18000,
  },
} as const;

export type Plan = keyof typeof PLAN_LIMITS;
