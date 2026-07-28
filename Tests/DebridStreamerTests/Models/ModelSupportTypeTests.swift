import Testing
import Foundation
import GRDB
@testable import DebridStreamer

@Suite("Model support type tests")
struct ModelSupportTypeTests {
    @Test("LibraryFolder ID and name helpers")
    func libraryFolderHelpers() {
        #expect(LibraryFolder.systemFolderID(for: .watchlist) == "system-watchlist")
        #expect(LibraryFolder.systemFolderID(for: .favorites) == "system-favorites")
        #expect(LibraryFolder.systemFolderID(for: .custom) == "system-custom")

        #expect(LibraryFolder.systemFolderName(for: .watchlist) == "Watchlist")
        #expect(LibraryFolder.systemFolderName(for: .favorites) == "Library")
        #expect(LibraryFolder.systemFolderName(for: .custom) == "Custom")

        #expect(LibraryFolder.behaviorFolderID(for: .watched) == "system-favorites-watched")
        #expect(LibraryFolder.behaviorFolderID(for: .releaseWait) == "system-favorites-release-wait")
        #expect(LibraryFolder.behaviorFolderID(for: .systemRoot) == "system-favorites")
        #expect(LibraryFolder.behaviorFolderID(for: .manual) == "system-favorites")

        #expect(LibraryFolder.behaviorFolderName(for: .watched) == "Watched")
        #expect(LibraryFolder.behaviorFolderName(for: .releaseWait) == "Release Wait")
        #expect(LibraryFolder.behaviorFolderName(for: .systemRoot) == "Library")
        #expect(LibraryFolder.behaviorFolderName(for: .manual) == "Folder")
    }

    @Test("LibraryFolder row decoding uses defaults for invalid enum values")
    func libraryFolderRowDecodingDefaults() throws {
        let validRow = Row([
            LibraryFolder.Columns.id.rawValue: "folder-a",
            LibraryFolder.Columns.name.rawValue: "Root",
            LibraryFolder.Columns.parentId.rawValue: "parent-1",
            LibraryFolder.Columns.listType.rawValue: UserLibraryEntry.ListType.favorites.rawValue,
            LibraryFolder.Columns.folderKind.rawValue: LibraryFolder.FolderKind.watched.rawValue,
            LibraryFolder.Columns.isSystem.rawValue: false,
            LibraryFolder.Columns.createdAt.rawValue: Date(timeIntervalSince1970: 50),
            LibraryFolder.Columns.updatedAt.rawValue: Date(timeIntervalSince1970: 60)
        ])

        let valid = try LibraryFolder(row: validRow)
        #expect(valid.id == "folder-a")
        #expect(valid.name == "Root")
        #expect(valid.parentId == "parent-1")
        #expect(valid.listType == .favorites)
        #expect(valid.folderKind == .watched)
        #expect(valid.isSystem == false)
        #expect(valid.createdAt == Date(timeIntervalSince1970: 50))
        #expect(valid.updatedAt == Date(timeIntervalSince1970: 60))

        let invalidListType = Row([
            LibraryFolder.Columns.id.rawValue: "folder-b",
            LibraryFolder.Columns.name.rawValue: "Fallback",
            LibraryFolder.Columns.listType.rawValue: "other",
            LibraryFolder.Columns.folderKind.rawValue: LibraryFolder.FolderKind.releaseWait.rawValue,
            LibraryFolder.Columns.isSystem.rawValue: false,
            LibraryFolder.Columns.createdAt.rawValue: Date(timeIntervalSince1970: 10),
            LibraryFolder.Columns.updatedAt.rawValue: Date(timeIntervalSince1970: 11)
        ])

        let fallback = try LibraryFolder(row: invalidListType)
        #expect(fallback.listType == .custom)
        #expect(fallback.folderKind == .releaseWait)

        let invalidFolderKindWhenSystem = Row([
            LibraryFolder.Columns.id.rawValue: "folder-c",
            LibraryFolder.Columns.name.rawValue: "System",
            LibraryFolder.Columns.listType.rawValue: UserLibraryEntry.ListType.favorites.rawValue,
            LibraryFolder.Columns.folderKind.rawValue: "not-a-kind",
            LibraryFolder.Columns.isSystem.rawValue: true,
            LibraryFolder.Columns.createdAt.rawValue: Date(timeIntervalSince1970: 12),
            LibraryFolder.Columns.updatedAt.rawValue: Date(timeIntervalSince1970: 12)
        ])

        let systemFallback = try LibraryFolder(row: invalidFolderKindWhenSystem)
        #expect(systemFallback.folderKind == .systemRoot)

        let invalidFolderKindWhenManual = Row([
            LibraryFolder.Columns.id.rawValue: "folder-d",
            LibraryFolder.Columns.name.rawValue: "Folder",
            LibraryFolder.Columns.listType.rawValue: UserLibraryEntry.ListType.favorites.rawValue,
            LibraryFolder.Columns.folderKind.rawValue: "not-a-kind",
            LibraryFolder.Columns.isSystem.rawValue: false,
            LibraryFolder.Columns.createdAt.rawValue: Date(timeIntervalSince1970: 13),
            LibraryFolder.Columns.updatedAt.rawValue: Date(timeIntervalSince1970: 13)
        ])

        let manualFallback = try LibraryFolder(row: invalidFolderKindWhenManual)
        #expect(manualFallback.folderKind == .manual)
    }

    @Test("LibraryFolder init sets defaults and preserves provided times")
    func libraryFolderInitDefaults() {
        let created = Date(timeIntervalSince1970: 1000)
        let updated = Date(timeIntervalSince1970: 2000)
        let folder = LibraryFolder(
            id: "folder-default",
            name: "Custom Folder",
            listType: .custom,
            createdAt: created,
            updatedAt: updated
        )

        #expect(folder.id == "folder-default")
        #expect(folder.name == "Custom Folder")
        #expect(folder.parentId == nil)
        #expect(folder.folderKind == .manual)
        #expect(folder.isSystem == false)
        #expect(folder.createdAt == created)
        #expect(folder.updatedAt == updated)
    }

    @Test("LibraryFoldering normalizes and matches folder selections")
    func libraryFolderingNormalizationAndMatching() {
        #expect(LibraryFoldering.allFoldersLabel == "All Folders")
        #expect(LibraryFoldering.unsortedLabel == "Unsorted")
        #expect(LibraryFoldering.entryID(mediaId: "m1", listType: .favorites) == "m1-favorites")

        #expect(LibraryFoldering.normalizeStoredFolder(nil) == nil)
        #expect(LibraryFoldering.normalizeStoredFolder(" /Drama/   SciFi//") == "Drama/SciFi")
        #expect(LibraryFoldering.normalizeStoredFolder("Drama\\SciFi\\") == "Drama/SciFi")

        #expect(LibraryFoldering.displayName(for: nil) == "Unsorted")
        #expect(LibraryFoldering.displayName(for: " /Drama/SciFi/ ") == "Drama/SciFi")

        #expect(LibraryFoldering.matches(storedFolder: "Drama/SciFi", selectionPath: "Drama/SciFi"))
        #expect(LibraryFoldering.matches(storedFolder: "Drama/SciFi", selectionPath: "Drama"))
        #expect(LibraryFoldering.matches(storedFolder: "Drama\nSciFi", selectionPath: "Drama") == false)
        #expect(LibraryFoldering.matches(storedFolder: nil, selectionPath: "Any") == false)

        #expect(LibraryFoldering.folderSegments(from: " Drama / SciFi / New ") == ["Drama", "SciFi", "New"])
        #expect(LibraryFoldering.folderSegments(from: "   ") == [])
    }

    @Test("Cast member profile URLs build and handle missing paths")
    func castMemberProfileURLs() {
        let withProfile = CastMember(id: 1, name: "Hero", character: "Lead", profilePath: "/actor.jpg")
        let withoutProfile = CastMember(id: 2, name: "No", character: "None", profilePath: nil)

        #expect(withProfile.profileURL == URL(string: "https://image.tmdb.org/t/p/w185/actor.jpg"))
        #expect(withoutProfile.profileURL == nil)

        let blankPath = CastMember(id: 3, name: "Blank", character: "Extra", profilePath: "")
        #expect(blankPath.profileURL == nil)
    }

    @Test("Feedback enums expose stable raw values and labels")
    func feedbackEnumValueAndNames() {
        #expect(FeedbackScaleMode.none.id == "none")
        #expect(FeedbackScaleMode.likeDislike.rawValue == "like_dislike")
        #expect(FeedbackScaleMode.scale1to10.displayName == "1 to 10")
        #expect(FeedbackScaleMode.scale1to100.displayName == "1 to 100")

        #expect(WatchedState.watched.rawValue == "watched")
        #expect(WatchedState.notWatched.rawValue == "not_watched")

        #expect(FeedbackSource.manual.rawValue == "manual")
        #expect(FeedbackSource.auto.rawValue == "auto")
    }
}
