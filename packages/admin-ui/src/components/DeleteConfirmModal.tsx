import { Modal, Text, Button, Group } from "@mantine/core";

export interface DeleteConfirmModalProps {
  opened: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  message?: string;
  loading?: boolean;
}

export function DeleteConfirmModal({
  opened,
  onClose,
  onConfirm,
  title = "Delete Deployment",
  message = "Are you sure you want to delete this deployment? This will remove the plan and all associated deployment history. This action cannot be undone.",
  loading = false,
}: DeleteConfirmModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title={title}>
      <Text mb="md">{message}</Text>
      <Group justify="flex-end" gap="sm">
        <Button variant="subtle" onClick={onClose}>
          Cancel
        </Button>
        <Button color="red" onClick={onConfirm} loading={loading}>
          Delete
        </Button>
      </Group>
    </Modal>
  );
}
