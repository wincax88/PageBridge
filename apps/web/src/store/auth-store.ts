import { create } from "zustand";

interface AuthState {
  accessToken: string | null;
  userEmail: string | null;
  setSession: (accessToken: string, userEmail: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  userEmail: localStorage.getItem("pagebridge.userEmail"),
  setSession: (accessToken, userEmail) => {
    localStorage.setItem("pagebridge.userEmail", userEmail);
    set({ accessToken, userEmail });
  },
  clearSession: () => {
    localStorage.removeItem("pagebridge.userEmail");
    set({ accessToken: null, userEmail: null });
  }
}));
