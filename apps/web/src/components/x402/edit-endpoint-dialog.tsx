'use client';

/**
 * EditEndpointDialog — quick edit form for an existing x402 endpoint.
 *
 * Covers the fields the dashboard exposes today: name, description,
 * service_slug, backend_url, base_price, currency-readonly, status,
 * category. Editing a published endpoint's discovery-relevant fields
 * (description, basePrice, network, serviceSlug, backendUrl, category)
 * automatically marks `metadata_dirty=true` server-side and triggers
 * the auto-republish hook on the API.
 */
import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@sly/ui';
import type { X402Endpoint, UpdateX402EndpointInput, X402EndpointStatus } from '@sly/api-client';
import { useApiClient } from '@/lib/api-client';

interface EditEndpointDialogProps {
  endpoint: X402Endpoint;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATUS_OPTIONS: X402EndpointStatus[] = ['active', 'paused', 'disabled'];

export function EditEndpointDialog({ endpoint, open, onOpenChange }: EditEndpointDialogProps) {
  const api = useApiClient();
  const queryClient = useQueryClient();

  const [name, setName] = useState(endpoint.name);
  const [description, setDescription] = useState(endpoint.description ?? '');
  const [basePrice, setBasePrice] = useState(String(endpoint.basePrice));
  const [serviceSlug, setServiceSlug] = useState(endpoint.serviceSlug ?? '');
  const [backendUrl, setBackendUrl] = useState(endpoint.backendUrl ?? '');
  const [category, setCategory] = useState(endpoint.category ?? '');
  const [status, setStatus] = useState<X402EndpointStatus>(endpoint.status);
  const [submitting, setSubmitting] = useState(false);

  // Re-hydrate when a different endpoint is opened in the same component.
  useEffect(() => {
    if (open) {
      setName(endpoint.name);
      setDescription(endpoint.description ?? '');
      setBasePrice(String(endpoint.basePrice));
      setServiceSlug(endpoint.serviceSlug ?? '');
      setBackendUrl(endpoint.backendUrl ?? '');
      setCategory(endpoint.category ?? '');
      setStatus(endpoint.status);
    }
  }, [open, endpoint]);

  const handleSave = async () => {
    if (!api) {
      toast.error('API client not available');
      return;
    }

    const priceNum = Number(basePrice);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      toast.error('Base price must be a positive number');
      return;
    }

    // Only send fields that actually changed — keeps the audit trail clean
    // and avoids spurious metadata_dirty flips on unchanged fields.
    const patch: UpdateX402EndpointInput = {};
    if (name !== endpoint.name) patch.name = name;
    if (description !== (endpoint.description ?? '')) patch.description = description;
    if (priceNum !== endpoint.basePrice) patch.basePrice = priceNum;
    if (serviceSlug !== (endpoint.serviceSlug ?? '')) patch.serviceSlug = serviceSlug || undefined;
    if (backendUrl !== (endpoint.backendUrl ?? '')) patch.backendUrl = backendUrl || undefined;
    if (category !== (endpoint.category ?? '')) patch.category = category || undefined;
    if (status !== endpoint.status) patch.status = status;

    if (Object.keys(patch).length === 0) {
      toast.info('No changes to save');
      onOpenChange(false);
      return;
    }

    setSubmitting(true);
    try {
      await api.x402Endpoints.update(endpoint.id, patch);
      toast.success('Endpoint updated');
      queryClient.invalidateQueries({ queryKey: ['x402', 'endpoint', endpoint.id] });
      queryClient.invalidateQueries({ queryKey: ['x402', 'endpoints'] });
      // If the endpoint is published and a discovery-relevant field changed,
      // the API will mark metadata_dirty and re-trigger publish — refresh
      // the publish-status timeline so the user sees the new event.
      queryClient.invalidateQueries({
        queryKey: ['x402', 'endpoint', endpoint.id, 'publish-status'],
      });
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      toast.error('Update failed', { description: message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit endpoint</DialogTitle>
          <DialogDescription>
            Changes to discovery-relevant fields (description, price, slug, backend, category)
            will automatically re-trigger publish if this endpoint is already on agentic.market.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label htmlFor="edit-name">Name</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="HTTPBin Test Echo"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="edit-description">Description</Label>
            <textarea
              id="edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="flex min-h-[80px] w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              placeholder="What this endpoint does, in one or two sentences"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {description.trim().length} chars (≥ 20 to publish)
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="edit-price">Base price ({endpoint.currency})</Label>
              <Input
                id="edit-price"
                type="number"
                step="0.0001"
                min="0.0001"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                placeholder="0.0010"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Price per call. Probe spend ≈ this amount.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-status">Status</Label>
              <select
                id="edit-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as X402EndpointStatus)}
                className="flex h-9 w-full rounded-md border border-gray-200 bg-white px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="edit-slug">Service slug</Label>
              <Input
                id="edit-slug"
                value={serviceSlug}
                onChange={(e) => setServiceSlug(e.target.value.toLowerCase())}
                placeholder="weather"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                URL path component for the gateway.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-category">Category</Label>
              <Input
                id="edit-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. weather, finance, ai"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="edit-backend">Backend URL</Label>
            <Input
              id="edit-backend"
              type="url"
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              placeholder="https://your-api.example.com/endpoint"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Sly proxies paid requests here after settle. Never exposed to buyers.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
